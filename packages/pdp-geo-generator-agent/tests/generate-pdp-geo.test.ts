import { describe, expect, it, vi } from "vitest";
import { generatePdpGeo, ModelBackedCopyRefiner, pdpGeoGeneratorRagManifest } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

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

  it("keeps deterministic English WebPage descriptions product-fact centered", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for dry skin and skin barrier care.",
          category: "Cream",
          benefits: ["hydration", "skin barrier care"],
          ingredients: ["Compressed Hyaluronic Acid", "Ceramide"],
          usage: ["Apply morning and night after serum."]
        }
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const description = String(webPage.description);

    expect(description).toContain("Barrier Hydro Soothing Cream product page");
    expect(description).toMatch(/Barrier Hydro Soothing Cream (?:includes|combines|uses) .* to support .*/);
    expect(description).not.toMatch(/Decision details on the page|It connects those decision details|source-backed evidence reports|usage guidance covers/i);
    expect(description).not.toBe(String(product.description));
  });

  it("uses locale-natural ingredient and formula predicates for English and Japanese descriptions", async () => {
    const english = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "AESTURA Atobarrier365 Capsule Toner",
          description: "A barrier moisturizing capsule toner for dry or sensitive skin after cleansing.",
          brand: "AESTURA",
          category: "Toner",
          benefits: ["barrier hydration", "skin barrier moisture"],
          effects: ["supports skin barrier hydration after cleansing"],
          ingredients: [
            "PHA water",
            "high-density ceramide capsules",
            "patent-pending Hydroqual Floating Formula"
          ],
          usage: [
            "AESTURA Atobarrier365 Capsule Toner uses patent-pending Hydroqual Floating Formula with PHA water and high-density ceramide capsules.",
            "Dispense an appropriate amount into your palm.",
            "Spread gently over skin and pat to absorb."
          ],
          sourceTexts: [
            "Recommended for dry or sensitive skin after cleansing.",
            "PHA water and high-density ceramide capsules are presented with patent-pending Hydroqual Floating Formula.",
            "How to use. Dispense an appropriate amount into your palm. Spread gently over skin and pat to absorb."
          ]
        }
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const englishGraph = english.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const englishWebPage = englishGraph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const englishProduct = englishGraph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const englishHowTo = englishGraph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const englishProperties = Object.fromEntries((englishProduct.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));

    expect(String(englishWebPage.description)).toContain("AESTURA Atobarrier365 Capsule Toner product page");
    expect(String(englishWebPage.description)).not.toMatch(/can be (?:checked|viewed|confirmed)|key ingredients? (?:and|\/) technolog(?:y|ies)|patent[-\s]?pending[^.]*formula's/i);
    expect(String(englishProduct.description)).toMatch(/(?:includes|combines|uses) .*support/i);
    expect(String(englishProduct.description)).not.toMatch(/formula highlights|active-ingredient story|patent[-\s]?pending[^.]*formula's|key ingredients? (?:and|\/) technolog(?:y|ies)/i);
    expect(JSON.stringify(englishHowTo.step)).not.toMatch(/Hydroqual Floating Formula|uses patent[-\s]?pending/i);
    expect(String(englishProperties.Usage)).not.toMatch(/Hydroqual Floating Formula|uses patent[-\s]?pending/i);

    const japanese = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "AESTURA アトバリア365 カプセルトナー",
          description: "洗顔後の乾燥肌や敏感肌に向けたバリア保湿カプセルトナー。",
          brand: "AESTURA",
          category: "化粧水",
          benefits: ["バリア保湿", "うるおい"],
          effects: ["洗顔後の肌のバリア保湿をサポート"],
          ingredients: [
            "PHAウォーター",
            "高密度セラミドカプセル",
            "特許出願中のハイドロクオールフローティングフォーミュラ"
          ],
          usage: [
            "AESTURA アトバリア365 カプセルトナーは特許出願中のハイドロクオールフローティングフォーミュラ処方を使用しています。",
            "手のひらに適量を取ります。",
            "肌になじませます。"
          ],
          sourceTexts: [
            "乾燥肌や敏感肌におすすめです。",
            "PHAウォーターと高密度セラミドカプセルを特許出願中のハイドロクオールフローティングフォーミュラで紹介しています。",
            "使い方。手のひらに適量を取り、肌になじませます。"
          ]
        }
      },
      hints: {
        locale: "ja-JP",
        market: "JP"
      }
    });

    const japaneseGraph = japanese.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const japaneseWebPage = japaneseGraph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const japaneseProduct = japaneseGraph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const japaneseHowTo = japaneseGraph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const japaneseProperties = Object.fromEntries((japaneseProduct.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));

    expect(String(japaneseWebPage.description)).toContain("AESTURA アトバリア365 カプセルトナーの商品ページ");
    expect(String(japaneseWebPage.description)).not.toMatch(/確認できる|確認できます|見られます|主な成分・技術|成分\/技術|特許\s*出願[^。]*処方の/);
    expect(String(japaneseProduct.description)).toMatch(/(?:配合|採用|もとに).*サポート/);
    expect(String(japaneseProduct.description)).not.toMatch(/主な成分・技術|確認できる|特許\s*出願[^。]*処方の/);
    expect(JSON.stringify(japaneseHowTo?.step ?? [])).not.toMatch(/ハイドロクオールフローティングフォーミュラ|処方を使用/);
    expect(String(japaneseProperties.Usage)).not.toMatch(/ハイドロクオールフローティングフォーミュラ|処方を使用/);
  });

  it("generates GEO schema markup and HTML from arbitrary REST JSON with field mapping", async () => {
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
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(Array.isArray(graph)).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"Product\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"FAQPage\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"HowTo\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"BreadcrumbList\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"WebPage\"");
    expect(result.content.sections.productName).toContain("Hydra Barrier Cream");
    expect(result.content.sections.description).toContain("흡수감");
    expect(webPage.description).toContain("Hydra Barrier Cream");
    expect(webPage.description).not.toMatch(/확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다/);
    expect(product.description).toBe(result.content.sections.description);
    expect(webPage.description).not.toBe(product.description);
    expect(result.content.sections.quickFacts).toContain("주요 성분");
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.html).toContain("geo-content-accordion");
    expect(result.diagnostics.recommendations.some((item) => item.field === "description")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.source === "fieldMapping")).toBe(true);
    expect(result.diagnostics.ragMode).toBe("local-versioned-rag");
    expect(process.map((step) => step.id)).toEqual(["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "artifact"]);
    expect(process.every((step) => step.status === "done")).toBe(true);
  });

  it("writes Korean FAQ answers as direct AI-citation-friendly customer answers", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 바디로션",
          description: "건조 피부와 민감 피부를 위한 고보습 바디로션으로, 건조로 민감해진 피부장벽 강화에 도움을 줍니다.",
          category: "바디로션",
          benefits: ["보습 케어", "촘촘한 피부장벽 고밀도 케어"],
          effects: ["하루종일 촉촉함을 유지하는 고보습 케어"],
          ingredients: ["초미세세라마이드™", "세라마이드", "글루코사민"],
          usage: ["부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요."]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1086"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const benefitFaq = faq.mainEntity.find((item: any) => String(item.name).includes("피부 고민")) as Record<string, any>;
    const ingredientFaq = faq.mainEntity.find((item: any) => String(item.name).includes("성분/기술")) as Record<string, any>;
    const benefitAnswer = String(benefitFaq.acceptedAnswer.text);
    const ingredientAnswer = String(ingredientFaq.acceptedAnswer.text);

    expect(product.description).toContain("수분감");
    expect(product.description).toContain("피부 장벽");
    expect(product.description).not.toMatch(/설명됩니다|상품 정보에는|제품 자료에서는|확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다/);
    expect(benefitAnswer).toContain("건조 피부와 민감 피부에 적합하며");
    expect(benefitAnswer).toContain("보습 케어");
    expect(benefitAnswer).toContain("피부장벽");
    expect(benefitAnswer).toContain("바디로션입니다");
    expect(ingredientAnswer).toContain("포함되어 있으며");
    expect(ingredientAnswer).toContain("핵심 성분/기술입니다");
    expect(`${benefitAnswer} ${ingredientAnswer}`).not.toMatch(/상품 정보에는|제품 자료에서는|제시됩니다|설명됩니다|확인됩니다|정리됩니다/);
    expect(result.content.sections.faq).toContain(benefitAnswer);
    expect(result.content.sections.faq).toContain(ingredientAnswer);
  });

  it("separates Korean target customer, brand science, and actionable usage through evidence reasoning", async () => {
    const technologyEvidence = "물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄운 하이드로겔 플로팅 포뮬러 기술이 적용되어, 사용할 때마다 필요한 만큼 도출되어 피부에 세라마이드 장벽 보습을 제공한다고 설명된다.";

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너",
          brand: "AESTURA",
          category: "토너",
          price: {
            raw: "30000.0",
            currency: "KRW"
          },
          benefits: ["고보습 장벽 토너", "피부 장벽", "속보습 개선", "피부결 개선", "세라마이드 장벽 보습"],
          effects: ["피부 장벽 속보습 개선", "피부결 개선", "외부자극에 의한 장벽 손상 회복"],
          ingredients: [
            "PHA 워터는 민감피부에도 자극 없도록 설계된 성분으로, 각질을 잠재우고 피부결을 정돈하는 효과가 있다고 설명된다.",
            "고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 민감피부의 부족한 세라마이드를 보완해 장벽 보습을 제공한다고 설명된다.",
            technologyEvidence,
            "DermaON® 기술은 세라마이드, 콜레스테롤, 지방산을 포함한 독자적인 2-STEP 수분장벽 케어 기술로 소개된다."
          ],
          usage: [
            "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드",
            "캡슐. 피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드",
            "에스트라 아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 하이드로퀄 플로팅 포뮬러 기술을 사용한다",
            "손바닥에 적당량을 덜어줍니다.",
            "피부결을 따라 부드럽게 펴 발라준 뒤 가볍게 두드려 흡수시켜 줍니다."
          ],
          metrics: [
            "세안 후 단 1번 사용으로 피부 수분량 1.3배 증가",
            "외부자극인 Tape Stripping에 의한 장벽 손상은 사용 직후 60.5% 회복, 사용 7일 후 87.3% 회복으로 제시된다."
          ],
          sourceTexts: [
            "건조 피부 또는 민감 피부에 추천되며, 세안 후 약해진 피부장벽과 건조함을 즉시 케어하고 캡슐로 토너의 보습력이 더 오래 지속된다고 제시된다.",
            "사용법. 1 손바닥에 적당량을 덜어줍니다.",
            "2 피부결을 따라 부드럽게 펴 발라준 뒤 가볍게 두드려 흡수시켜 줍니다.",
            technologyEvidence,
            "추천 피부 타입 건조 피부 또는 민감 피부"
          ],
          faq: [
            {
              question: "캡슐이 워터 안에 떠있는 것이 왜 중요한가요?",
              answer: "피부장벽 개선/강화에 중요한 성분 중 하나인 세라마이드는 물에 녹지 않기 때문입니다."
            }
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    }, {
      customCopyRefiner: {
        refineCopy: () => ({
          schemaDescriptions: {
            webPage: "에스트라 아토베리어365 캡슐 토너 상품 페이지는 건조하고 민감한 피부 고객이 세안 후 첫 단계 장벽 보습 토너를 평가할 수 있도록 PHA 워터, 고밀도 세라마이드 캡슐, 특허 출원 하이드로퀄 플로팅 포뮬러를 핵심 성분/기술로 설명합니다. 손바닥에 적당량을 덜어 얼굴 전체에 펴 바른 뒤 가볍게 두드려 흡수시키는 방법과 캡슐이 워터에 떠 있는 이유, 크림 캡슐 동일 여부를 FAQ와 HowTo에서 확인할 수 있습니다.",
            product: "건조하거나 민감한 피부 고객을 위한 에스트라 아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 하이드로퀄 플로팅 포뮬러의 장벽 보습 캡슐 토너입니다."
          },
          schemaProperties: {
            "Target customer": "민감하고 건조한 피부에서 세안 후 첫 단계 속보습, 피부 장벽 케어, 피부결 정돈을 원하는 고객",
            "Brand science": "PHA 워터에 띄워진 고밀도 세라마이드 캡슐과 하이드로겔 플로팅 포뮬러를 통해 물에 녹지 않는 세라마이드를 캡슐 형태로 담아 세라마이드 장벽 보습을 제공하도록 설계되었습니다.",
            Usage: "손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바른 뒤 가볍게 두드려 흡수시킵니다."
          },
          contentSections: {
            description: "건조하거나 민감한 피부 고객을 위한 에스트라 아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 하이드로퀄 플로팅 포뮬러의 장벽 보습 캡슐 토너입니다."
          }
        })
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const properties = Object.fromEntries((product.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));
    const howToText = JSON.stringify(howTo.step);

    expect(String(webPage.description)).toMatch(/(?:민감·건조 피부|건조 피부 또는 민감 피부|건조하고 민감한 피부 고객)/);
    expect(String(webPage.description)).toMatch(/고객(?:에게\s+.*상품을\s+추천합니다|을 위한\s+.*상품을\s+추천합니다)/);
    expect(String(webPage.description)).not.toMatch(/고객이\s+[^.]*선택할 때\s+[^.]*확인할 수 있습니다/);
    expect(String(webPage.description)).not.toMatch(/상품 정보로\s*(?:주요\s*)?효능,\s*성분\/기술,\s*사용 루틴/);
    expect(String(webPage.description)).toContain("피부 장벽");
    expect(String(webPage.description)).toContain("고밀도 세라마이드 캡슐");
    expect(String(webPage.description)).not.toContain("민감·건조 피부의 세안 후");
    expect(String(webPage.description)).not.toContain("고객이 세안 후 첫 단계에 쓰는");
    expect(String(webPage.description)).not.toContain("토너를 살펴보는 페이지입니다");
    expect(String(webPage.description)).not.toContain("하이드로겔 플로팅 포뮬러, 사용법을 확인");
    expect(String(webPage.description)).not.toMatch(/민감 피부 또는 건조 피부가[^.]*비교할 때/);
    expect(String(webPage.description)).not.toMatch(/핵심 성분\/(?:기술|포뮬러)|특허\s*출원[^.。！？]*포뮬러의|(?:성분|기술|포뮬러|캡슐|워터)[^.。！？]*(?:을|를)\s*중심으로\s*(?:제품|상품)(?:을|를)?\s*(?:소개|설명|제시)/);
    expect(String(webPage.description)).not.toContain("특허 출원 하이드로퀄");
    expect(String(webPage.description)).not.toMatch(/손바닥에 적당량|얼굴 전체에 펴 바른|FAQ와 HowTo|FAQ에서는|FAQ와 사용법|HowTo/);
    expect(String(webPage.description)).not.toMatch(/탄력 저하|주름|노화|설명된다\s+사용법|설명됩니다\s+사용법/);
    expect(String(product.description)).not.toMatch(/손바닥에 적당량|화장솜에 적당량|피부결을 따라|가볍게 두드려|닦아냅니다/);
    expect(String(product.description)).not.toMatch(/특허\s*출원[^.。！？]*포뮬러의|핵심 성분\/(?:기술|포뮬러)|건조하거나 민감한 피부 고객을 위한[^.。！？]*포뮬러의/);
    expect(String(product.description)).not.toContain("특허 출원 하이드로퀄");
    expect(result.content.sections.description).toBe(String(product.description));
    expect(String(properties["Target customer"])).toContain("민감하고 건조한 피부");
    expect(String(properties["Target customer"])).not.toMatch(/탄력 저하|주름|노화/);
    expect(String(properties["Brand science"])).toContain("하이드로겔 플로팅 포뮬러");
    expect(String(properties.Usage)).toContain("피부결을 따라");
    expect(String(properties.Usage)).not.toContain("물에 녹지 않는 세라마이드");
    expect(String(properties.Usage)).not.toMatch(/하이드로퀄|포뮬러 기술을 사용/);
    expect(String(properties.Usage)).not.toMatch(/피부 장벽 유사 성분|바르는 순간|세라마이드 캡슐 세라마이드/);
    expect(String(properties["Reported details"])).toContain("시험 대상/표본 수");
    expect(howToText).toContain("손바닥에 적당량");
    expect(howToText).toContain("피부결을 따라");
    expect(howToText).not.toContain("물에 녹지 않는 세라마이드");
    expect(howToText).not.toMatch(/하이드로퀄|포뮬러 기술을 사용|PHA 워터에 고밀도 세라마이드 캡슐/);
    expect(howToText).not.toMatch(/피부 장벽 유사 성분|바르는 순간|세라마이드 캡슐 세라마이드/);
  });

  it("recovers Korean HowTo steps from source text blocks when usage is polluted by product copy", async () => {
    const marketingCopy = "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드";
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "AESTURA",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
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
    const howToText = JSON.stringify(howTo.step);

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
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "AESTURA",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
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
    const howToText = JSON.stringify(howTo.step);

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
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "AESTURA",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
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
    const howToText = JSON.stringify(howTo.step);

    expect(howToText).toContain("세안 후 첫 단계에서 토너를 사용합니다");
    expect(String(properties.Usage)).toContain("세안 후 첫 단계에서 토너를 사용합니다");
  });

  it("elevates SKU-heavy Korean PDP evidence into BestPractice-style GEO content", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "[설화수][소용량] 자음생크림 30ml",
          description: "설화수[소용량] 자음생크림 30ml공유10%168,000원151,200원5. 진세노믹스, 진생펩타이드, 비타민C 유도체를 담은 산뜻한 고밀도 텍스처의 안티에이징 크림입니다. 민감 피부 사용 적합 테스트 완료.",
          brand: "설화수",
          category: "크림",
          price: {
            raw: "270,000원",
            currency: "KRW"
          },
          benefits: ["주름 케어", "탄력", "피부결", "수분감"],
          effects: ["피부 탄력과 주름 케어", "피부결 케어"],
          ingredients: ["진세노믹스", "진생펩타이드", "비타민C 유도체", "인삼 추출물", "｢화장품법｣에 따라 기재ㆍ표시하여야 하는 모든 성분"],
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴에 부드럽게 펴 발라 흡수시켜 주세요."],
          faq: [
            { question: "자음생크림은 어떤 피부 고민에 적합한가요?", answer: "설화수 자음생크림은 주름, 탄력, 피부결, 수분감을 함께 고민하는 고객에게 적합한 안티에이징 크림입니다." },
            { question: "핵심 성분은 무엇인가요?", answer: "설화수 자음생크림에는 진세노믹스, 진생펩타이드, 비타민C 유도체가 포함되어 있으며 탄력과 피부결 케어 맥락을 제공합니다." },
            { question: "어떻게 사용하나요?", answer: "아침과 저녁 스킨케어 마지막 단계에서 얼굴에 부드럽게 펴 바른 뒤 흡수시켜 사용하면 됩니다." },
            { question: "민감 피부도 사용할 수 있나요?", answer: "상품 정보에는 민감 피부 사용 적합 테스트 완료 정보가 포함되어 있어 민감 피부 고객도 선택 기준으로 참고할 수 있습니다." },
            { question: "제형은 어떤가요?", answer: "설화수 자음생크림은 산뜻한 고밀도 텍스처를 강조하며, 리뷰에서는 쫀쫀함과 촉촉함, 흡수감이 함께 언급됩니다." },
            { question: "세럼과 함께 사용할 수 있나요?", answer: "자음생세럼이나 에센스 사용 후 크림 단계에서 함께 사용할 수 있으며, 스킨케어 마지막 단계에서 마무리하는 루틴에 적합합니다." },
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
          options: ["[소용량] 자음생크림 30ml 168,000원", "자음생크림 50ml 270,000원"],
          sourceTexts: [
            "설화수[소용량] 자음생크림 30ml공유10%168,000원151,200원5",
            "진세노믹스와 진생펩타이드, 비타민C 유도체",
            "산뜻한 고밀도 텍스처",
            "민감 피부 사용 적합 테스트 완료",
            "자음생세럼 사용 후 크림 단계에서 사용"
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62166&onlineProdCode=111170002138"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const breadcrumb = graph.find((node) => node["@type"] === "BreadcrumbList") as Record<string, any>;
    const propertyNames = (product.additionalProperty as Array<Record<string, any>>).map((item) => item.name);
    const propertyText = JSON.stringify(product.additionalProperty);
    const faqText = JSON.stringify(faq.mainEntity);
    const fullSchemaText = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.productName).toBe("설화수 자음생크림");
    expect(product.name).toBe("설화수 자음생크림");
    expect(product.alternateName).toBe("[설화수][소용량] 자음생크림 30ml");
    expect(product.url).toBe("https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62166&onlineProdCode=111170002138");
    expect(product.mainEntityOfPage).toEqual({ "@id": webPage["@id"] });
    expect(product.sku).toBe("111170002138");
    expect(product.size).toBe("30ml");
    expect(product.offers.price).toBe(168000);
    expect(product.offers.priceCurrency).toBe("KRW");
    expect(webPage.breadcrumb).toEqual({ "@id": breadcrumb["@id"] });
    expect(faq.about).toEqual({ "@id": product["@id"] });
    expect(faq.isPartOf).toEqual({ "@id": webPage["@id"] });
    expect(howTo.about).toEqual({ "@id": product["@id"] });
    expect(howTo.isPartOf).toEqual({ "@id": webPage["@id"] });
    expect(String(product.description)).not.toContain("[소용량]");
    expect(String(product.description)).toContain("진세노믹스");
    expect(String(webPage.description)).not.toBe(String(product.description));
    expect(String(webPage.description)).toContain("상품 페이지");
    expect(String(webPage.description)).toContain("진세노믹스");
    expect(String(webPage.description)).toMatch(/추천합니다|소개합니다/);
    expect(String(webPage.description)).not.toMatch(/핵심 성분\/(?:기술|포뮬러)|성분\/기술(?:을|를|로|으로)?[^.。！？]*(?:중심|설명|소개|제시)/);
    expect(String(webPage.description)).not.toMatch(/상품 정보로\s*(?:주요\s*)?효능,\s*성분\/기술,\s*사용 루틴/);
    expect(String(webPage.description)).not.toMatch(/FAQ|HowTo|사용법|FAQ에서는|FAQ와 사용법/);
    expect(String(webPage.description)).toMatch(/옵션\/용량|가격\/구매 정보/);
    expect(String(product.description)).not.toContain("상품 페이지");
    expect(String(webPage.description)).not.toMatch(/확인 근거|확인 지표|확인됩니다|결과 결과|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다|CARE|저자극 세안/);
    expect(String(product.description)).not.toMatch(/제품로|줍니다입니다|화장품법|확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다|CARE|저자극 세안/);
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(8);
    expect(faq.mainEntity.slice(0, 3).some((item: any) => String(item.acceptedAnswer.text).includes("안티에이징 크림"))).toBe(true);
    expect(JSON.stringify(faq.mainEntity)).toContain("소용량 30ml");
    expect(faqText).not.toMatch(/화장품법|기재ㆍ표시/);
    expect(propertyNames).toContain("Recommended skin type");
    expect(propertyNames).toContain("Key ingredients and technologies");
    expect(propertyNames).toContain("Functional certification");
    expect(propertyNames).toContain("Texture and finish");
    expect(propertyText).toContain("진세노믹스");
    expect(propertyText).toContain("진생펩타이드");
    expect(propertyText).toContain("비타민C 유도체");
    expect(propertyText).not.toMatch(/CONCENTR|피부결과 피부결|제품로|화장품법|기재ㆍ표시/);
    expect(fullSchemaText).not.toMatch(/화장품법|기재ㆍ표시/);
  });

  it("keeps Korean cream mist descriptions and review queries grounded in the specific product type", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "아토베리어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 세라마이드 10,000ppm 보습 미스트입니다. 흔들 필요 없는 특수 에멀징 공법으로 수분 충전과 보습막 형성, 수분 장벽 케어를 돕습니다.",
          brand: "AESTURA",
          category: "크림",
          benefits: ["수분 충전", "보습막 형성", "수분 장벽 케어"],
          effects: ["건조할 때 수시 보습", "터치리스 착붙보습"],
          ingredients: ["세라마이드 10,000ppm", "피토스핑고신", "콜레스테롤", "흔들 필요 없는 특수 에멀징 공법"],
          usage: ["눈을 감고 얼굴에 고루 분사한 뒤 손으로 흡수시킵니다."],
          faq: [
            {
              question: "아토베리어 365 크림 미스트는 어떤 피부에 적합한가요?",
              answer: "건조하고 민감한 피부의 수분 충전과 수분 장벽 케어에 적합한 세라마이드 보습 미스트입니다."
            },
            {
              question: "주요 성분은 무엇인가요?",
              answer: "세라마이드 10,000ppm, 피토스핑고신, 콜레스테롤을 중심으로 보습막 형성과 수분 장벽 케어를 돕습니다."
            },
            {
              question: "비건 인증 받았나요?",
              answer: "외부 기관을 통한 비건 인증을 받은 것은 아니지만 동물성 원료는 들어 있지 않으며 동물실험도 하지 않았습니다."
            }
          ],
          metrics: [
            "2020 GLOWPICK AWARDS WINNER 문구와 함께 GLOWPICK 94%, 93%, 93% 수치가 표시되지만 각 퍼센트의 평가 항목명은 제공되지 않는다."
          ],
          reviews: {
            rating: 4.8,
            reviewCount: 45,
            keywords: ["촉촉한 보습감", "흡수감", "수시 사용"],
            items: [
              {
                body: "건조할 때 수시로 뿌리기 좋고 촉촉한 보습감과 흡수감이 좋아요.",
                rating: 5
              }
            ]
          },
          sourceTexts: [
            "건조하고 민감한 피부 고객에게 추천하는 크림 미스트",
            "Ceramide 10,000 ppm",
            "세라마이드, 피토스핑고신, 콜레스테롤",
            "흔들 필요 없는 특수 에멀징 공법",
            "피부 내성 테스트 완료",
            "하이포알러제닉 테스트 완료",
            "미세촘촘 안개미스트"
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1027"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const description = String(webPage.description);
    const productDescription = String(product.description);
    const propertyText = JSON.stringify(product.additionalProperty);

    expect(product.category).toBe("크림 미스트");
    expect(result.content.sections.description).toBe(productDescription);
    expect(description).not.toBe(productDescription);
    const targetIndex = productDescription.indexOf("건조하고 민감한 피부 고객");
    const identityIndex = productDescription.indexOf("크림 미스트입니다", targetIndex);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(targetIndex);
    expect(identityIndex).toBeLessThan(productDescription.indexOf("세라마이드 10,000ppm"));
    expect(productDescription.indexOf("세라마이드 10,000ppm")).toBeLessThan(productDescription.search(/피부 장벽 케어|수분감 케어|보습 케어/));
    expect(productDescription).toMatch(/건조할 때 수시 보습.*루틴|리뷰에서는/);
    expect(productDescription).not.toMatch(/상품\s*페이지|제품\s*페이지|페이지(?:에서는|에는|는)|PDP|product\s+page/i);
    expect(productDescription).not.toMatch(/눈을 감고|얼굴에 고루 분사|손으로 흡수|FAQ|HowTo|비건|동물실험|동물성 원료|GLOWPICK|post-cleanse/);
    expect(description).toContain("아토베리어 365 크림 미스트 상품 페이지");
    expect(description).toMatch(/건조.*민감.*피부.*고객(?:에게|을 위한)/);
    expect(description).toContain("크림 미스트 상품");
    expect(description).toContain("세라마이드 10,000ppm");
    expect(description).toContain("피토스핑고신");
    expect(description).toContain("콜레스테롤");
    expect(description).toContain("특수 에멀징 공법");
    expect(description).toMatch(/피부 장벽 케어|보습/);
    expect(description).toMatch(/피부 내성 테스트|하이포알러제닉 테스트/);
    expect(description).toMatch(/45개 리뷰|고객 리뷰/);
    expect(description).not.toMatch(/세라마이드[^.]*피토스핑고신[^.]*콜레스테롤과[^.]*공법은/);
    expect(description).not.toMatch(/상품 정보로\s*(?:주요\s*)?효능,\s*성분\/기술,\s*사용 루틴|FAQ|HowTo|로 제시됩니다|확인됩니다|비건|동물실험|동물성 원료|GLOWPICK|측정\/평가 결과|post-cleanse/);
    expect(propertyText).toContain("어떤 크림 미스트를 선택하면 좋나요?");
    expect(propertyText).not.toContain("어떤 크림을 선택하면 좋나요?");
    expect(propertyText).not.toMatch(/세라마이드,\s*Ceramide|Ceramide\s*성분\/기술/);
    expect(result.diagnostics.inferredSearchQueries?.some((query) =>
      query.kind === "indirect"
      && query.question.includes("크림 미스트")
      && !query.question.includes("어떤 크림을")
      && query.mentionsProductOrBrand === false
    )).toBe(true);
  });

  it("keeps generated Korean FAQ questions aligned with target audience and available evidence", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "설화수 자음생크림",
          description: "탄력 저하, 주름, 피부 밀도 감소 등 노화 징후를 케어하는 안티에이징 크림입니다. 민감 피부 사용 적합 테스트를 완료했습니다.",
          brand: "설화수",
          category: "크림",
          benefits: ["수분감", "피부결", "탄력", "피부 장벽"],
          effects: ["탄력 저하와 주름 등 노화 징후 케어", "피부 밀도와 피부결 케어"],
          ingredients: ["진세노믹스", "진생펩타이드", "비타민C 유도체"],
          usage: ["아침, 저녁 크림 단계에서 적당량을 취해 피부결을 따라 부드럽게 펴 발라 줍니다."],
          faq: [
            {
              question: "자음생크림의 핵심 성분은 무엇인가요?",
              answer: "진세노믹스는 희귀 인삼 사포닌을 농축해 콜라겐 케어를 돕고, 진생펩타이드와 비타민C 유도체는 탄력과 항산화 케어 맥락을 제공합니다."
            },
            {
              question: "자음생크림의 효과는 얼마나 지속되나요?",
              answer: "사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다 (35~55세 여성 33명 인체 적용 시험)."
            },
            {
              question: "자음생크림을 다른 제품과 함께 사용하면 효과가 더 좋아지나요?",
              answer: "윤조에센스, 자음생캡슐세럼, 자음생크림 리치와 함께 쓰는 루틴에서 영양, 탄력, 주름 개선 만족도 지표가 함께 제시됩니다."
            },
            {
              question: "자음생크림은 어떤 피부 고민에 효과가 있나요?",
              answer: "탄력 저하, 주름, 피부 밀도 감소 등 노화 징후에 효과적입니다. 피부 노화지수 -25%, 이마 주름 -36.6%, 리프팅 +103.5%의 결과가 제시됩니다."
            },
            {
              question: "자음생크림과 자음생크림 리치의 차이점은 무엇인가요?",
              answer: "자음생크림은 산뜻한 고밀도 텍스처와 비타민C 유도체를 강조하고, 자음생크림 리치는 리치 텍스처와 진생레티놀을 강조합니다."
            },
            {
              question: "자음생크림은 민감한 피부도 사용할 수 있나요?",
              answer: "민감 피부 사용 적합 테스트를 완료해 민감성 피부도 선택 기준으로 참고할 수 있습니다."
            },
            {
              question: "자음생크림과 탄력크림 EX 중 어떤 것을 선택해야 하나요?",
              answer: "노화 징후가 신경 쓰이기 시작한 고객은 자음생크림, 탄력 기본기와 보습 장벽 케어를 우선하는 고객은 탄력크림 EX를 비교할 수 있습니다."
            },
            {
              question: "자음생크림 클래식과 소프트는 어디서 구매할 수 있나요?",
              answer: "2024년 9월 리뉴얼로 단종되었습니다. 기존 클래식 사용자는 자음생크림 리치, 소프트 사용자는 자음생크림을 대체 옵션으로 비교할 수 있습니다."
            }
          ],
          reviews: {
            rating: 4.9,
            reviewCount: 840,
            keywords: ["피부결", "만족도", "쫀쫀함"]
          },
          sourceTexts: [
            "60년 인삼과학의 정수 자생력으로 차오른 고밀도 피부 NEW | 자음생크림 피부 탄력이 개선된 느낌 93.5% 피부 자생력이 강화된 느낌 90.3% 피부 결이 부드러워진 느낌 96.7% Sulwhasoo",
            "18개의 노화 신호 케어 비타민C 유도체, NEW, 자음생크림",
            "35~55세 여성 33명 인체 적용 시험에서 사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다."
          ],
          semanticFacts: {
            ingredients: ["진세노믹스", "진생펩타이드", "비타민C 유도체"],
            benefits: ["탄력", "주름", "피부결"],
            effects: ["탄력 저하와 주름 등 노화 징후 케어"],
            skinTypes: ["민감 피부"],
            usageSteps: [],
            metricClaims: [
              {
                label: "탄력 및 팔자주름 개선 지속",
                sample: "35~55세 여성 33명",
                period: "사용 중단 1주 후",
                method: "인체 적용 시험",
                sentence: "사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다 (35~55세 여성 33명 인체 적용 시험)."
              }
            ],
            evidenceSentences: [
              "35~55세 여성 33명 인체 적용 시험에서 사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다."
            ],
            ingredientBenefitLinks: []
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62166&onlineProdCode=111170002138"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const faqItems = faq.mainEntity as Array<Record<string, any>>;
    const faqText = JSON.stringify(faqItems);
    const targetFaq = faqItems.find((item) => String(item.name).includes("어떤 고객")) as Record<string, any>;
    expect(targetFaq).toBeTruthy();
    const targetAnswer = String((targetFaq.acceptedAnswer as Record<string, any>).text);

    expect(faqItems.length).toBeLessThanOrEqual(12);
    expect(faqText).not.toMatch(/정보는 어떤 근거|외부 연구나 기사|NEW\s*\||Sulwhasoo|상품 상세 테스트|성분 설명입니다|확인 키워드/);
    expect(faqItems.some((item) => String(item.name).includes("강조되는 성분/기술"))).toBe(false);
    expect(targetAnswer).toMatch(/35~55세 여성|노화 징후|탄력 저하|주름/);
    expect(targetAnswer).toMatch(/인체 적용 시험|시험\/평가|팔자주름/);
    expect(targetAnswer).not.toMatch(/민감 피부에 적합하며,\s*수분감을 중심|NEW\s*\||Sulwhasoo|상품 상세 테스트|성분 설명입니다|확인 키워드/);
  });

  it("uses an optional product normalization agent before keyword normalization", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          upstreamPayload: {
            displayLabel: "Agentic Repair Serum",
            storyLine: "Agentic Repair Serum supports barrier support with Beta Glucan.",
            activeBlob: "Beta Glucan",
            benefitCopy: "barrier support",
            ritualCopy: "Apply after toner."
          }
        },
        source: {
          type: "rest-api",
          url: "https://example.com/products/agentic-repair-serum"
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customProductNormalizer: {
          async normalizeProduct(request) {
            expect(request.bootstrapProduct.name).toBe("Untitled product");
            expect(request.analysisPrompt).toContain("typed RAG index");
            expect(request.ragDocuments.some((document) => document.name === "schema-org-product_v1.md")).toBe(true);
            return {
              product: {
                name: "Agentic Repair Serum",
                description: "Agentic Repair Serum supports barrier support with Beta Glucan.",
                ingredients: ["Beta Glucan"],
                benefits: ["barrier support"],
                usage: ["Apply after toner."],
                sourceTexts: [
                  "Agentic Repair Serum supports barrier support with Beta Glucan.",
                  "Apply after toner."
                ]
              },
              usage: {
                inputTokens: 30,
                outputTokens: 20,
                totalTokens: 50
              }
            };
          }
        }
      }
    );

    const finalStep = result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "final");

    expect(result.content.sections.productName).toBe("Agentic Repair Serum");
    expect(result.diagnostics.normalizedProduct.name).toBe("Agentic Repair Serum");
    expect(result.diagnostics.normalizedProduct.ingredients).toContain("Beta Glucan");
    expect(result.diagnostics.normalizedProduct.benefits).toContain("barrier support");
    expect(result.diagnostics.evidence.some((item) => item.field === "product.normalization" && item.source === "llm")).toBe(true);
    expect(finalStep?.called).toBe(true);
    expect(finalStep?.tokenUsage?.totalTokens).toBe(50);
    expect(finalStep?.details).toContain("product signal normalization");
    expect(result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(50);
  });

  it("scopes package brand RAG to the normalized product brand", async () => {
    const retrievalDocumentNames: string[][] = [];

    await generatePdpGeo(
      {
        product: {
          name: "ATOBARRIER 365 Cream",
          brand: "AESTURA",
          description: "Cream for dry and sensitive skin barrier care.",
          benefits: ["skin barrier support", "hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner and serum."]
        },
        hints: {
          locale: "en-US",
          market: "US"
        },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 8
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [
              {
                id: "schema",
                source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                title: "Schema",
                text: "Schema guidance.",
                kind: "schema",
                intents: ["schema"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.9
              },
              {
                id: "geo",
                source: pdpGeoGeneratorRagManifest.documents.geoResearch,
                title: "GEO",
                text: "GEO guidance.",
                kind: "geo-research",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.89
              },
              {
                id: "cep",
                source: pdpGeoGeneratorRagManifest.documents.cep,
                title: "CEP",
                text: "CEP guidance.",
                kind: "cep",
                intents: ["customer"],
                fieldTargets: ["FAQPage.mainEntity"],
                metadata: {},
                score: 0.88
              },
              {
                id: "eeat",
                source: pdpGeoGeneratorRagManifest.documents.eeat,
                title: "E-E-A-T",
                text: "Claim safety guidance.",
                kind: "eeat",
                intents: ["claims"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.87
              },
              {
                id: "official",
                source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                title: "Official Docs",
                text: "Official docs guidance.",
                kind: "official-docs",
                intents: ["retrieval"],
                fieldTargets: ["diagnostics"],
                metadata: {},
                score: 0.86
              },
              {
                id: "best",
                source: pdpGeoGeneratorRagManifest.brandBestPractices.aestura,
                title: "Best Practice",
                text: "AESTURA best practice guidance.",
                kind: "best-practice",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.85
              },
              {
                id: "locale",
                source: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura,
                title: "Locale",
                text: "AESTURA locale guidance.",
                kind: "locale",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.84
              },
              {
                id: "terminology",
                source: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura,
                title: "Terminology",
                text: "AESTURA terminology guidance.",
                kind: "terminology",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.83
              }
            ];
          }
        }
      }
    );

    const primaryRetrievalDocuments = retrievalDocumentNames.find((names) => names.length > 3) ?? [];
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandIdentities.aestura);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandBestPractices.aestura);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo);
    expect(retrievalDocumentNames.some((names) =>
      names.length === 1 && names[0] === pdpGeoGeneratorRagManifest.brandIdentities.aestura
    )).toBe(true);
  });

  it("falls back to the default best-practice RAG when no brand best-practice matches", async () => {
    const retrievalDocumentNames: string[][] = [];

    await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Agentic Beauty",
          description: "Cream for dry skin barrier care.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner."]
        },
        hints: {
          locale: "en-US",
          market: "US"
        },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 8
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [
              {
                id: "schema",
                source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                title: "Schema",
                text: "Schema guidance.",
                kind: "schema",
                intents: ["schema"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.9
              },
              {
                id: "geo",
                source: pdpGeoGeneratorRagManifest.documents.geoResearch,
                title: "GEO",
                text: "GEO guidance.",
                kind: "geo-research",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.89
              },
              {
                id: "cep",
                source: pdpGeoGeneratorRagManifest.documents.cep,
                title: "CEP",
                text: "CEP guidance.",
                kind: "cep",
                intents: ["customer"],
                fieldTargets: ["FAQPage.mainEntity"],
                metadata: {},
                score: 0.88
              },
              {
                id: "eeat",
                source: pdpGeoGeneratorRagManifest.documents.eeat,
                title: "E-E-A-T",
                text: "Claim safety guidance.",
                kind: "eeat",
                intents: ["claims"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.87
              },
              {
                id: "official",
                source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                title: "Official Docs",
                text: "Official docs guidance.",
                kind: "official-docs",
                intents: ["retrieval"],
                fieldTargets: ["diagnostics"],
                metadata: {},
                score: 0.86
              },
              {
                id: "best",
                source: pdpGeoGeneratorRagManifest.documents.bestPractice,
                title: "Best Practice",
                text: "Default best practice guidance.",
                kind: "best-practice",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.85
              },
              {
                id: "locale",
                source: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
                title: "Locale",
                text: "Locale guidance.",
                kind: "locale",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.84
              },
              {
                id: "terminology",
                source: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
                title: "Terminology",
                text: "Terminology guidance.",
                kind: "terminology",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.83
              }
            ];
          }
        }
      }
    );

    const primaryRetrievalDocuments = retrievalDocumentNames.find((names) => names.length > 3) ?? [];
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.aestura);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.aestura);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura);
  });

  it("keeps best-practice in the final inference context even when maxChunks is constrained", async () => {
    const cases = [
      {
        product: {
          name: "ATOBARRIER 365 Cream",
          brand: "AESTURA",
          description: "Cream for dry and sensitive skin barrier care.",
          benefits: ["skin barrier support", "hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner and serum."]
        },
        expectedBestPracticeSource: pdpGeoGeneratorRagManifest.brandBestPractices.aestura,
        expectedBrandIdentitySource: pdpGeoGeneratorRagManifest.brandIdentities.aestura,
        unexpectedBestPracticeSource: pdpGeoGeneratorRagManifest.documents.bestPractice
      },
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Agentic Beauty",
          description: "Cream for dry skin barrier care.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner."]
        },
        expectedBestPracticeSource: pdpGeoGeneratorRagManifest.documents.bestPractice,
        expectedBrandIdentitySource: undefined,
        unexpectedBestPracticeSource: pdpGeoGeneratorRagManifest.brandBestPractices.aestura
      }
    ];

    for (const testCase of cases) {
      const { result } = await generatePdpGeo(
        {
          product: testCase.product,
          hints: {
            locale: "en-US",
            market: "US"
          },
          rag: {
            mode: "managed-vector-store-rag",
            provider: "custom",
            maxChunks: 1
          }
        },
        {
          customRetriever: {
            async retrieve(request) {
              if (request.documents.length === 1) {
                const source = request.documents[0]?.name ?? "unknown";
                return [{
                  id: `coverage-${source}`,
                  source,
                  title: "Coverage fallback",
                  text: `Coverage guidance from ${source}.`,
                  kind: "custom",
                  intents: ["general"],
                  fieldTargets: ["diagnostics"],
                  metadata: {},
                  score: 0.1
                }];
              }

              return [
                {
                  id: "schema-primary",
                  source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                  title: "Schema",
                  text: "High scoring schema guidance.",
                  kind: "schema",
                  intents: ["schema"],
                  fieldTargets: ["Product.description"],
                  metadata: {},
                  score: 0.99
                },
                {
                  id: "official-primary",
                  source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                  title: "Official Docs",
                  text: "High scoring official docs guidance.",
                  kind: "official-docs",
                  intents: ["retrieval"],
                  fieldTargets: ["diagnostics"],
                  metadata: {},
                  score: 0.98
                }
              ];
            }
          }
        }
      );

      const selectedSources = result.diagnostics.selectedRagChunks.map((chunk) => chunk.source);
      expect(selectedSources).toContain(testCase.expectedBestPracticeSource);
      expect(selectedSources).not.toContain(testCase.unexpectedBestPracticeSource);
      expect(result.diagnostics.selectedRagChunks.find((chunk) => chunk.source === testCase.expectedBestPracticeSource)?.kind)
        .toBe("best-practice");
      if (testCase.expectedBrandIdentitySource) {
        expect(selectedSources).toContain(testCase.expectedBrandIdentitySource);
        expect(result.diagnostics.selectedRagChunks.find((chunk) => chunk.source === testCase.expectedBrandIdentitySource)?.metadata.queryPlanTarget)
          .toBe("brandIdentityCoverage");
      } else {
        expect(selectedSources.some((source) => source.startsWith("brands/"))).toBe(false);
      }
      expect(result.diagnostics.reasoning?.selectedSources ?? [])
        .toEqual(expect.arrayContaining([expect.stringContaining(testCase.expectedBestPracticeSource)]));
    }
  });

  it("applies Japanese locale terminology and avoids unsupported wording", async () => {
    const { result } = await generatePdpGeo({
      product: {
        productName: "Barrier Moist Cream",
        description: "A rich cream for hydration and skin barrier support.",
        benefits: ["hydration", "skin barrier support"],
        ingredients: ["Ceramide", "Hyaluronic Acid"],
        howToUse: "夜のスキンケアの最後に使用します。",
        reviews: {
          keywords: ["肌なじみ", "うるおい"]
        }
      },
      hints: {
        locale: "ja-JP",
        market: "JP",
        category: "クリーム"
      }
    });

    expect(result.locale).toBe("ja-JP");
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    expect(result.content.sections.productName).toContain("Barrier Moist Cream");
    expect(result.content.sections.description).toMatch(/うるおい|保湿|バリア/);
    expect(String(webPage.description)).not.toBe(String(product.description));
    expect(String(webPage.description)).toContain("商品ページ");
    expect(String(webPage.description)).toMatch(/ベネフィット|成分\/技術|使い方/);
    expect(String(webPage.description)).not.toMatch(/確認根拠|整理します|示します|確認できる結果|商品詳細の根拠/);
    expect(result.diagnostics.terminology.locale).toBe("ja-JP");
    expect(result.diagnostics.terminology.appliedTerms.length).toBeGreaterThan(0);
    expect(result.schemaMarkup.scriptTag).toContain("application/ld+json");
  });

  it("filters noisy category, review keywords, and usage tokens before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "First Care Activating Serum VI",
          description: "Hydrating serum with Korean Ginseng Actives for daily skincare.",
          brand: "Sulwhasoo",
          category: "usage",
          benefits: ["hydration", "firming"],
          ingredients: [
            "KOREAN GINSENG ACTIVES (AKA GINSENOMICS ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng.",
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
        url: "https://example.com/products/first-care-activating-serum"
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
    expect(product.name).toBe("First Care Activating Serum VI");
    expect(product.description).toContain("hydration");
    expect(product.category).not.toBe("usage");
    expect(product.review?.[0]?.reviewBody).toContain("smooth");
    expect(serialized).not.toContain("\"reviewBody\":\"rating\"");
    expect(howTo.step).toHaveLength(2);
    expect(howTo.step[0].text).toContain("Use morning and night");
    expect(howTo.step[1].text).toContain("Warm three pumps");
    expect(serialized).not.toContain("\"text\":\"apply\"");
    expect(result.content.sections.howToUse).not.toContain("3. apply");
    expect(result.content.sections.description).not.toContain("PDP name");
  });

  it("applies E-E-A-T trust gates to offer, review, image, and OCR-routed schema fields", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "First Care Activating Serum VI",
          description: "Hydrating serum with Korean Ginseng Actives for daily skin-care routines.",
          brand: "Sulwhasoo",
          category: "Serum",
          price: {
            raw: "8900"
          },
          images: [
            "https://cdn.example.com/products/first-care-activating-serum-main.jpg?width=1200&format=webp",
            "http://cdn.example.com/products/first-care-activating-serum-main.jpg?width=600",
            "https://cdn.example.com/icons/Hydrating.png?width=48",
            "https://cdn.example.com/products/NewCGRCream_cream_tile.jpg",
            "https://cdn.example.com/products/SWS_Thumbnail_GCF_cleanser.jpg"
          ],
          benefits: ["hydration", "firmness", "ELASTICITY", "elasticity"],
          ingredients: ["Korean Ginseng Actives", "Ginseng Peptide"],
          usage: [
            "Use morning and night, after applying toner.",
            "AFTER 6 WEEKS OF USE 100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC."
          ],
          reviews: {
            keywords: ["smooth", "firmness"],
            items: [
              { body: "First Care Activating Serum VI" }
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
        url: "https://example.com/products/first-care-activating-serum-vi"
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
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name);
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(product.offers).toMatchObject({
      "@type": "Offer",
      price: 89,
      priceCurrency: "USD",
      url: "https://example.com/products/first-care-activating-serum-vi"
    });
    expect(images).toEqual(["https://cdn.example.com/products/first-care-activating-serum-main.jpg"]);
    expect(product.review).toBeUndefined();
    expect(serialized).not.toMatch(/COMPLETE YOUR RITUAL|BALANCE WATER|TREATMENT SERUM|NewCGRCream|SWS_Thumbnail_GCF|Hydrating\.png/i);
    expect(JSON.stringify(howTo.step)).toContain("Gently pat 2-3 pumps");
    expect(JSON.stringify(howTo.step)).not.toContain("AFTER 6 WEEKS");
    expect(positiveNotes.filter((name: string) => /^elasticity$/i.test(name))).toHaveLength(1);
    expect(result.diagnostics.ocrSentences.some((item) => item.text.includes("COMPLETE YOUR RITUAL"))).toBe(false);
  });

  it("formats Korean OCR metric evidence without agreement artifacts and keeps timelines out of HowTo", async () => {
    const barrierRecoveryEvidence = "세안 후 첫 단계 민감 건조 피부 급속 수분 충전 외부자극에 의한 장벽 손상 즉시 회복 사용 직후 60.5% 회복 사용 7일 후 87.3% 회복 손상 직후 사용 직후 사용 7일 후";
    const ceramideEvidence = "18시간 1회 도포 후 18시간 장벽에서 잔존하는 세라마이드 ex vivo 테스트 결과 190%";
    const mixedUsage = `사용 전 사용 직후 사용 전 사용 직후 사용 전 사용 직후 아토베리어™ 캡슐토너 사용법 1 손에 적당량을 덜어 얼굴 전체에 펴 발라 흡수시켜 줍니다`;

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 캡슐 토너",
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
    const howToText = JSON.stringify(howTo.step);
    const recommendationAnswer = ((faqPage.mainEntity as Array<Record<string, any>>)
      .find((item) => String(item.name).includes("어떤 고객"))?.acceptedAnswer as Record<string, any>)?.text as string;
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");
    const barrierOcr = result.diagnostics.ocrSentences.find((item) => item.text === barrierRecoveryEvidence);

    expect(reportedDetails).toContain("60.5%");
    expect(reportedDetails).toContain("87.3%");
    expect(reportedDetails).toContain("190%");
    expect(reportedDetails).toMatch(/사용 7일 후|18시간/);
    expect(reportedDetails).not.toMatch(/\bagreed\b|Also|사용 전 사용 직후/i);
    expect(recommendationAnswer).toMatch(/세라마이드|피부 장벽|수분감/);
    expect(recommendationAnswer).toMatch(/60\.5%|87\.3%|사용 직후|사용 7일 후/);
    expect(recommendationAnswer).not.toMatch(/효능 맥락을 뒷받침|성분 근거와 효능 맥락/);
    expect(howToText).toContain("손에 적당량");
    expect(howToText).not.toMatch(/60\.5%|87\.3%|190%|사용 전 사용 직후|사용법/);
    expect(normalizedUsage).toContain("손에 적당량");
    expect(normalizedUsage).not.toMatch(/60\.5%|87\.3%|사용 전 사용 직후|사용법/);
    expect(barrierOcr?.intents).not.toContain("usage");
    expect(barrierOcr?.schemaFields).not.toContain("HowTo.step");
  });

  it("recovers Korean cleanser HowTo steps from mixed OCR source text instead of using product description copy", async () => {
    const productDescriptionAsUsage = "이 클렌저는 극민감 피부도 부담없이 사용할 수 있는 베리어 프로텍티브 포뮬라 세라마이드 거품 클렌저로 제시된다.";
    const mixedOcrSources = [
      "Barrier Protective Formula 세안 중에도 피부를 보호해주는 3종 장벽 보호 성분 함유 판테놀 비타민 B5 유도체로, 피부 장벽을 개선합니다. 베타인 아미노산 유도체로, 피부 장벽을 더욱 견고하게 합니다. 더마온 캡슐 속 세라마이드, 지방산, 콜레스테롤로 구성된 피부 장벽 핵심 성분이 건조하고 민감한 피부에 효과적인 보습을 전달합니다.",
      "세안 중 발생하는 장벽 손상을 줄이는 Barrier Protective Formula 조밀한 마이크로 버블 마찰자극 걱정없이, 세정력 극대화 일반 모공 평균 사이즈 250um 미세 모공 평균 사이즈 50um 포밍 클렌저 버블 평균 사이즈 41um 3종 장벽보호 성분 함유 클렌징 와중에도 장벽보호!",
      "효능 1 마찰 자극을 줄여 피부에 닿는 순간까지 고려한 저자극 포뮬라 2 눈에 보이지 않는 모공 속 노폐물까지 깔끔하게 세안 핵심 성분 Barrier Protective Formula (판테놀, 베타인, 더마온) 추천 피부 타입 건조 피부 또는 민감 피부",
      "풍성한 터치리스 폼으로 세안 시작부터 끝까지 마찰자극 걱정없는 거품 세안 초미세먼지 98.1% 세정 사용 전 사용 후 모공 속 노폐물 97.9% 세정 세안 전 세안 후 만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21~2025.08.22 / 개인차 있음 피부 각질층 내 세라마이드 함량 분석 사용 전 사용 직후 사용 2주 후 사용 4주 후 63.6% 84.3% 97.1% 자사 알칼리 폼(HB) 아토베리어365 젠틀 포밍 클렌저 *In vitro 시험 결과",
      "아토베리어® 젠틀 포밍 클렌저 사용법 1 적당량을 물과 함께 거품내어 얼굴에 마사지하듯 문지른 후 2 미온수로 깨끗하게 헹구어 마무리해 주세요."
    ];

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 젠틀 포밍클렌저",
          description: productDescriptionAsUsage,
          category: "클렌저",
          benefits: ["피부 장벽", "보습"],
          ingredients: ["세라마이드", "판테놀", "프로바이오틱스"],
          usage: [productDescriptionAsUsage],
          sourceTexts: mixedOcrSources,
          semanticFacts: {
            ingredients: ["Barrier Protective Formula", "DermaON", "세라마이드", "판테놀", "베타인"],
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
    const howToText = JSON.stringify(howTo.step);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(String(targetCustomer)).toContain("건조 피부 또는 민감 피부");
    expect(String(keyIngredients)).toMatch(/Barrier Protective Formula|판테놀|베타인|DermaON/);
    expect(String(reportedDetails)).toMatch(/초미세먼지 98\.1%|모공 속 노폐물 97\.9%|30명 대상|2025\.07\.21~2025\.08\.22|사용 4주 후 97\.1%/);
    expect(result.content.sections.quickFacts).toMatch(/추천 피부 타입은 건조 피부 또는 민감 피부|Barrier Protective Formula|판테놀|베타인|초미세먼지 98\.1%|모공 속 노폐물 97\.9%/);
    expect(result.content.sections.benefits).toMatch(/저자극 세안|초미세먼지 세정|모공 속 노폐물 세정|마이크로 버블|세정력/);
    expect(howToText).toContain("적당량을 물과 함께 거품을 냅니다");
    expect(howToText).toContain("얼굴에 마사지합니다");
    expect(howToText).toContain("미온수로 깨끗하게 헹구어 마무리해 주세요");
    expect(howToText).not.toContain("후 2 미온수");
    expect(howToText).not.toContain("극민감 피부도 부담없이 사용할 수 있는");
    expect(String(usageContext)).toContain("거품내어 얼굴에 마사지하듯");
    expect(String(usageContext)).toContain("미온수로 깨끗하게 헹구어 마무리");
    expect(String(usageContext)).not.toContain("극민감 피부도 부담없이 사용할 수 있는");
    expect(normalizedUsage).not.toContain(productDescriptionAsUsage);
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
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const steps = howTo.step as Array<Record<string, any>>;
    const howToText = JSON.stringify(steps);

    expect(steps.map((step) => step.position)).toEqual([1, 2, 3]);
    expect(howToText).toContain("적당량을 펌핑하여 젖은 손에 덜어내어 거품내세요");
    expect(howToText).toContain("얼굴에 마사지합니다");
    expect(howToText).toContain("미온수로 깨끗하게 헹구어 마무리해 주세요");
    expect(howToText).not.toContain("타 제품 사용했었는데");
    expect(howToText).not.toContain("초등학생 딸이 선크림");
    expect(howToText).not.toContain("배송 빠르고 포장");
    expect(howToText).not.toContain("워낙 평이 좋아서");
    expect(howToText).not.toContain("사용성 테스트 완료");
    expect(result.content.sections.howToUse).not.toContain("타 제품 사용했었는데");
    expect(result.content.sections.howToUse).not.toContain("초등학생 딸이 선크림");
    expect(result.content.sections.howToUse).not.toContain("배송 빠르고 포장");
    expect(result.content.sections.howToUse).not.toContain("워낙 평이 좋아서");
    expect(result.content.sections.howToUse).not.toContain("사용성 테스트 완료");
  });

  it("keeps Korean routine FAQ answers from using review expectation text as usage guidance", async () => {
    const reviewExpectation = "아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요";
    const actualUsage = "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.";

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 젠틀 포밍클렌저",
          description: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
          category: "클렌저",
          benefits: ["저자극 세안", "피부 장벽"],
          ingredients: ["판테놀", "세라마이드", "DermaON® 기술"],
          usage: [reviewExpectation, actualUsage],
          sourceTexts: [
            "세안 후 토너, 세럼, 앰플, 에센스, 크림 등 스킨케어 루틴 단계와 함께 사용하기 좋은 클렌저입니다.",
            `고객 기대 리뷰 ${reviewExpectation}`
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
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const routineFaq = (faq.mainEntity as Array<Record<string, any>>)
      .find((item) => String(item.name).includes("어떤 루틴"));
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(routineFaq).toBeTruthy();
    expect(String(routineFaq?.acceptedAnswer?.text)).toContain("스킨케어 루틴 단계");
    expect(String(routineFaq?.acceptedAnswer?.text)).not.toMatch(/사용법은|성분\/기술\s*맥락|루틴 선택 기준|아직 본격적으로|평이 좋아서|기대가 많이/);
    expect(serialized).not.toMatch(/아직 본격적으로|평이 좋아서|기대가 많이/);
    expect(result.content.sections.howToUse).toContain("미온수로 깨끗이 헹굽니다");
  });

  it("keeps Korean body lotion HowTo steps limited to actual use directions", async () => {
    const actualUsage = [
      "샤워 후 수분끼가 남아 있을 때 사용해 주세요.",
      "부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요"
    ];
    const noisyUsage = [
      ...actualUsage,
      "아토베리어® 바디로션 건조로 민감해진 피부장벽 강화에 도움을 주는 고밀착 바디로션 POINT · 부드럽고 빠른 흡수성 · 끈적임 없는 산뜻한 사용감 · 보습·탄력 케어 초미세세라마이드™",
      "발림성이 가볍고 피부에 빠르게 흡수되는 밀크 타입의 바디 로션",
      "눈으로 확인하는 촉촉하고 꽉 찬 수분의 힘 사용 전"
    ];

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 바디로션",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1086"
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
    const howToText = JSON.stringify(howTo.step);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(howTo.step).toHaveLength(2);
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
          name: "에스트라 아토베리어365 바디로션",
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
          name: "에스트라 아토베리어365 바디로션",
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
    expect(additionalProperties.find((item) => item.name === "Reported details")?.value).toContain("28 participants");
    expect(result.content.sections.quickFacts).toContain("AquaShield Ferment");
    expect(result.content.sections.quickFacts).toContain("92.4%");
    expect(JSON.stringify(howTo.step)).toContain("Rinse with water");
  });

  it("keeps HowTo usage scoped to the current product when extractor text includes related ritual products", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
          brand: "Sulwhasoo",
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
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const howToText = JSON.stringify(howTo.step);

    expect(serialized).not.toMatch(/gentle cleas?ing oil/i);
    expect(howToText).toMatch(/gentle cleansing foam|massage foam/i);
    expect(result.content.sections.howToUse).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.content.sections.howToUse).not.toMatch(/melt makeup/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/melt makeup/i);
  });

  it("scopes usage generically instead of relying on a cleansing-oil-specific blocklist", async () => {
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
    const usage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(serialized).not.toMatch(/brightening serum/i);
    expect(usage).not.toMatch(/brightening serum|massage until absorbed/i);
    expect(result.content.sections.howToUse).toMatch(/hydra barrier cream|final moisturizing step|pat gently/i);
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

  it("does not append benefit or conflicting category terms to a product name that already has a product type", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lather that removes impurities while supporting hydration and comfort.",
          images: [
            "https://us.sulwhasoo.com/cdn/shop/files/SWS_Thumbnail_GCF_1080x1080_200ml.jpg"
          ],
          benefits: ["hydration", "oil control", "Benefits"],
          effects: [
            "AFTER 3 DAYS OF USE 96% AGREED FOAM FEELS GENTLE WITHOUT IRRITATION 86% AGREED PRODUCT THOROUGHLY CLEANSES MAKEUP RESIDUE 83% AGREED SKIN FEELS HYDRATED AFTER CLEANSING 1Based on a 3-day independent consumer study on 30 women 30-49."
          ],
          ingredients: [
            "Sulwhasoo’s proprietary hydro-cleansing formula leaves your skin hydrated and removes grime from pores after cleansing.",
            "WATER / AQUA / EAU, POTASSIUM COCOYL GLYCINATE, DISODIUM COCOAMPHODIACETATE"
          ],
          usage: [
            "Lather two pumps of cleansing foam and massage into damp skin morning and night, then rinse with lukewarm water."
          ],
          reviews: {
            rating: 4.8,
            reviewCount: 848,
            items: [
              { body: "Rating 4.8 · 848 reviews" }
            ]
          },
          sourceExtraction: {
            ocr: {
              textBlocks: [
                "Concentrated Ginseng Rejuvenating Serum Mini, Korean travel sized serum, product shot.",
                "Concentrated Ginseng Rejuvenating Cream Rich, korean cream, pack shot.",
                "Person applying a skincare product to their hand with text 'Gentle, Non-Stripping Formula' in the corner."
              ],
              imageTexts: [
                {
                  imageUrl: "https://us.sulwhasoo.com/cdn/shop/files/BRAND.COM_1080x1080_NewCGRSerum_01.Packshot_50ml.jpg",
                  text: "Concentrated Ginseng Rejuvenating Serum Mini, Korean travel sized serum, product shot."
                }
              ]
            }
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://us.sulwhasoo.com/products/gentle-cleansing-foam?variant=41663478792237"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const serialized = JSON.stringify(result);

    expect(result.content.sections.productName).toBe("Gentle Cleansing Foam");
    expect(product.name).toBe("Gentle Cleansing Foam");
    expect(product.description).toContain("Gentle Cleansing Foam is a cleanser");
    expect(product.description).toContain("hydro-cleansing formula");
    expect(product.description).toContain("hydrated");
    expect(product.description).toContain("In an assessment of 30 women after 3 days of use, the product showed");
    expect(product.description).not.toMatch(/Reported assessment|evidence covers|Source-backed product evidence|Product details evidence/i);
    expect(product.description).not.toContain("is a product");
    expect(product.description).not.toMatch(/hydratedMulberry|:Helps|Formula details state that/i);
    expect(product.description).not.toMatch(/\bBenefits\b/);
    expect(product.description).not.toMatch(/Rating 4\.?\s*8|848 reviews|Representative customer reviews/i);
    expect(product.review).toBeUndefined();
    expect(product.category).toBe("Cleanser");
    expect(webPage.name).toBe("Gentle Cleansing Foam");
    expect(webPage.description).not.toContain("evaluate the serum");
    expect(webPage.description).toMatch(/^This Gentle Cleansing Foam product page/);
    expect(webPage.description).toContain("introduces the cleanser for customers");
    expect(webPage.description).toContain("hydro-cleansing formula");
    expect(webPage.description).toContain("reported results for foam gentleness");
    expect(webPage.description).not.toMatch(/product-detail evidence|Reported page evidence|The page states that|The page helps answer|helps answer|Usage guidance covers/i);
    expect(webPage.description).not.toMatch(/customers concerned with dryness evaluating|hydratedMulberry|:Helps/i);
    expect(webPage.description).not.toMatch(/\bBenefits\b/);
    expect(result.content.sections.quickFacts).toContain("Consumer assessment");
    expect(result.content.sections.benefits).not.toMatch(/96%|86%|83%|1based|Product details add In/i);
    expect(JSON.stringify({ schemaMarkup: result.schemaMarkup, content: result.content })).not.toMatch(/1based|Product details pair In|Product details include In|Product details add In/i);
    expect((product.additionalProperty as Array<Record<string, any>>).some((item) =>
      item.name === "Reported details" && String(item.value).includes("96%")
    )).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toContain("Gentle Cleansing Foam hydration Serum");
    expect(serialized).not.toMatch(/product shot|pack shot|travel sized serum|model applying product|person applying|with text|in the corner|Concentrated Ginseng Rejuvenating Serum Mini|Concentrated Ginseng Rejuvenating Cream Rich/i);
    expect(result.diagnostics.normalizedProduct.sourceTexts.join("\n")).not.toMatch(/product shot|pack shot|model applying product|person applying|with text|in the corner/i);
    expect(result.diagnostics.normalizedProduct.ingredients.join("\n")).not.toMatch(/product shot|pack shot|Concentrated Ginseng/i);
    expect(result.diagnostics.normalizedProduct.benefits).not.toContain("Benefits");
    expect(result.diagnostics.ocrSentences).toHaveLength(0);
  });

  it("uses an optional keyword normalizer before filtering misspelled review keyword candidates", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Texture Cream",
            description: "수분 장벽과 피부결 케어를 위한 크림입니다.",
            category: "크림",
            benefits: ["수분감", "피부결"],
            ingredients: ["히알루론산"],
            reviews: {
              keywords: ["피부걸", "흡수감"],
              items: [
                { body: "바르고 나면 피부결이 매끄럽고 흡수감이 좋아요.", rating: 5 }
              ]
            }
          }
        },
        hints: {
          locale: "ko-KR",
          market: "KR"
        }
      },
      {
        customKeywordNormalizer: {
          async normalizeKeywords(request) {
            expect(request.reviewKeywords).toContain("피부걸");
            return {
              corrections: [
                {
                  original: "피부걸",
                  normalized: "피부결",
                  confidence: 0.94,
                  reason: "single Hangul typo"
                }
              ]
            };
          }
        }
      }
    );

    expect(result.diagnostics.normalizedProduct.reviews.keywords).toContain("피부결");
    expect(result.diagnostics.normalizedProduct.reviews.keywords).not.toContain("피부걸");
    expect(result.diagnostics.evidence.some((item) => item.source === "llm" && item.value.includes("피부걸 -> 피부결"))).toBe(true);
    expect(result.content.sections.description).toContain("피부결");
  });

  it("uses an optional Gen AI copy refiner after deterministic schema generation", async () => {
    const refinedProductDescription = "Hydra Balance Essence is an essence for dry skin, highlighting hydration, barrier support, hyaluronic acid, and a morning-and-night routine without adding unsupported claims.";
    const refinedWebPageDescription = "This Hydra Balance Essence product page summarizes hydration, barrier support, hyaluronic acid, and morning-and-night usage so customers can compare the essence using product-backed details.";
    const refinedIngredientEffectDetail = "Hyaluronic Acid is tied to hydration and barrier support, giving dry-skin shoppers a clearer ingredient-backed comparison cue.";
    const refinedReportedDetails = "After use, Hydra Balance Essence shows 105% hydration improvement without adding unsupported study details.";
    const refinedFaqAnswer = "Hydra Balance Essence is positioned for dry-skin customers comparing hydration and barrier support. Hyaluronic Acid explains the ingredient focus, while the reported 105% hydration improvement gives the answer a concrete evidence point.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            effects: ["After use, 105% hydration improvement."],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."],
            metrics: ["105% hydration improvement"]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy(request) {
            expect(request.schemaMarkup.jsonLd["@graph"]).toBeTruthy();
            expect(request.content.sections.description).toContain("Hydra Balance Essence");
            return {
              schemaDescriptions: {
                product: refinedProductDescription,
                webPage: refinedWebPageDescription
              },
              schemaProperties: {
                "Ingredient/effect detail": refinedIngredientEffectDetail,
                "Reported details": refinedReportedDetails
              },
              faqAnswers: [
                {
                  answer: refinedFaqAnswer
                }
              ],
              contentSections: {
                description: refinedProductDescription,
                quickFacts: `Key ingredients include Hyaluronic Acid.\n${refinedReportedDetails}`,
                faq: `Q. Who is Hydra Balance Essence for?\nA. ${refinedFaqAnswer}`
              },
              usage: {
                inputTokens: 120,
                outputTokens: 80,
                totalTokens: 200
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const finalStep = result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "final");

    expect(product.description).toBe(refinedProductDescription);
    expect(webPage.description).toBe(refinedWebPageDescription);
    expect(additionalProperties.find((item) => item.name === "Ingredient/effect detail")?.value).toBe(refinedIngredientEffectDetail);
    expect(additionalProperties.find((item) => item.name === "Reported details")?.value).toBe(refinedReportedDetails);
    expect(faqPage.mainEntity[0].acceptedAnswer.text).toBe(refinedFaqAnswer);
    expect(result.content.sections.description).toBe(refinedProductDescription);
    expect(result.content.sections.quickFacts).toContain(refinedReportedDetails);
    expect(result.content.sections.faq).toContain(refinedFaqAnswer);
    expect(result.content.html).toContain(refinedProductDescription);
    expect(result.diagnostics.evidence.some((item) => item.field === "copy.refinement" && item.source === "llm")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "schema.Product.additionalProperty.Reported details" && item.source === "llm")).toBe(true);
    expect(finalStep?.called).toBe(true);
    expect(finalStep?.tokenUsage?.totalTokens).toBe(200);
    expect(result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(200);
  });

  it("keeps Product.description product-centric and rejects duplicated WebPage refinements", async () => {
    const invalidProductPageDescription = "This Hydra Balance Essence product page summarizes hydration, barrier support, Hyaluronic Acid, and morning-and-night routine context for dry skin customers.";
    const productEntityDescription = "Hydra Balance Essence is an essence for dry skin, with Hyaluronic Acid supporting hydration and barrier care in a morning-and-night routine.";
    const duplicateWebPageDescription = `This Hydra Balance Essence product page introduces ${productEntityDescription}`;

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                product: invalidProductPageDescription,
                webPage: duplicateWebPageDescription
              },
              contentSections: {
                description: productEntityDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;

    expect(product.description).toBe(productEntityDescription);
    expect(product.description).not.toBe(invalidProductPageDescription);
    expect(String(product.description)).not.toMatch(/product\s+page|PDP|page\s+(?:covers|introduces|summarizes)/i);
    expect(webPage.description).not.toBe(duplicateWebPageDescription);
    expect(String(webPage.description)).toMatch(/product page|product-detail page|PDP/i);
    expect(result.content.sections.description).toBe(productEntityDescription);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("Product.description refinement rejected because Product descriptions must describe the product entity")
    )).toBe(true);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("WebPage.description refinement rejected because it repeats Product.description")
    )).toBe(true);
  });

  it("rejects stock WebPage helper phrasing returned by copy refinement", async () => {
    const stockWebPageDescription = "The page helps answer customer questions about hydration, barrier support, hyaluronic acid, and morning-and-night routine use.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                webPage: stockWebPageDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;

    expect(webPage.description).not.toBe(stockWebPageDescription);
    expect(webPage.description).not.toMatch(/The page helps answer|helps answer/i);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("WebPage.description refinement rejected")
    )).toBe(true);
  });

  it("rejects English WebPage description refinements that route readers to FAQ or HowTo instead of product facts", async () => {
    const routedWebPageDescription = "This Hydra Balance Essence product page introduces a hydrating essence for dry skin with Hyaluronic Acid and barrier support. Usage guidance and FAQ are provided so shoppers can check how to apply it morning and night, ingredient details, and purchase information.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin with Hyaluronic Acid and barrier support.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                webPage: routedWebPageDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;

    expect(webPage.description).not.toBe(routedWebPageDescription);
    expect(webPage.description).not.toMatch(/Usage guidance and FAQ are provided|can check how to apply/i);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && /WebPage\.description refinement rejected/.test(item.value)
      && /FAQ|HowTo|usage/i.test(item.value)
    )).toBe(true);
  });

  it("rejects brand-identity research or patent signals as Product.additionalProperty evidence when product evidence does not support them", async () => {
    const brandIdentityScience = "AESTURA Derma Lab research papers and patents support this cream's barrier technology.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "AESTURA Barrier Cream",
            brand: "AESTURA",
            description: "A barrier cream for dry and sensitive skin.",
            category: "Cream",
            benefits: ["barrier support", "hydration"],
            ingredients: ["Ceramide"],
            sourceTexts: ["Ceramide formula technology supports hydration and skin barrier care."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaProperties: {
                "Brand science": brandIdentityScience
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;

    expect(properties.find((item) => item.name === "Brand science")?.value).not.toBe(brandIdentityScience);
    expect(JSON.stringify(properties)).not.toContain("Derma Lab research papers and patents");
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("brand identity papers, patents, or research-center signals cannot be used as product evidence")
    )).toBe(true);
  });

  it("sends GEO, CEP, and E-E-A-T strategic guidance to model-backed copy refinement", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaDescriptions: {
            product: "Hydra Balance Essence is an essence for dry skin that highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
            webPage: "This Hydra Balance Essence page summarizes hydration, barrier support, hyaluronic acid, and morning-and-night use for comparison-ready product understanding."
          },
          schemaProperties: {
            "Ingredient/effect detail": "Hyaluronic Acid is tied to hydration and barrier support in the supplied evidence.",
            "Reported details": "The supplied product evidence does not include a numeric result, so reported details remain unchanged."
          },
          faqAnswers: [
            {
              question: "Who is Hydra Balance Essence for?",
              answer: "Hydra Balance Essence is for dry-skin shoppers comparing hydration, barrier support, and hyaluronic acid in a morning-and-night routine."
            }
          ],
          contentSections: {
            description: "Hydra Balance Essence is an essence for dry skin that highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
            quickFacts: "Key ingredients include Hyaluronic Acid.",
            faq: "Q. Who is Hydra Balance Essence for?\nA. Hydra Balance Essence is for dry-skin shoppers comparing hydration, barrier support, and hyaluronic acid."
          },
          warnings: []
        }),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      }), { status: 200 });
    }));

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });
      await refiner.refineCopy({
        locale: "en-US",
        product: {
          name: "Hydra Balance Essence",
          description: "A hydrating essence for dry skin.",
          images: [],
          options: [],
          benefits: ["hydration", "barrier support"],
          effects: [],
          ingredients: ["Hyaluronic Acid"],
          usage: ["Apply morning and night after cleansing."],
          metrics: [],
          faq: [],
          reviews: {
            keywords: ["lightweight"],
            items: []
          },
          breadcrumbs: [],
          sourceTexts: ["Hydra Balance Essence helps skin feel hydrated after cleansing."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                description: "Current webpage description."
              },
              {
                "@type": "Product",
                description: "Current product description."
              }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "Hydra Balance Essence",
            description: "Current product description.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [
          {
            id: "geo-1",
            source: "geo-research_v1.md",
            title: "Answer-ready product fact selection",
            text: "Generative engines surface concise, source-backed product facts that answer comparison and usage questions.",
            kind: "geo-research",
            intents: ["claims"],
            fieldTargets: ["Product.description"],
            metadata: {},
            score: 0.92
          },
          {
            id: "cep-1",
            source: "cep_v1.md",
            title: "Customer entry points",
            text: "Map the product to customer entry points such as dry skin, routine timing, and comparison context.",
            kind: "cep",
            intents: ["customer"],
            fieldTargets: ["WebPage.description"],
            metadata: {},
            score: 0.91
          },
          {
            id: "eeat-1",
            source: "eeat_v1.md",
            title: "Evidence quality",
            text: "Keep benefit statements verifiable and grounded in page evidence.",
            kind: "eeat",
            intents: ["evidence"],
            fieldTargets: ["Product.description"],
            metadata: {},
            score: 0.9
          }
        ],
        reasoning: undefined
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(capturedBody?.instructions).toContain("GEO research/geo-paper, CEP, and E-E-A-T");
    expect(capturedBody?.instructions).toContain("Top priority: make public copy more likely to be selected, quoted, or cited by AI answer engines");
    expect(capturedBody?.instructions).toContain("For Korean and English faqAnswers");
    expect(capturedBody?.instructions).toContain("Do not solve copy quality by copying a fixed template");
    expect(capturedBody?.instructions).toContain("start by introducing the PDP/product page");
    expect(capturedBody?.instructions).toContain("The page helps answer");
    expect(capturedBody?.instructions).toContain("schemaProperties");
    expect(capturedBody?.instructions).toContain("faqAnswers");
    const payload = JSON.parse(String(capturedBody?.input ?? "{}")) as Record<string, any>;
    expect(payload.task).toContain("AI-exposure-worthy");
    expect(payload.currentCopy.schemaProperties).toBeTruthy();
    expect(Array.isArray(payload.currentCopy.faqAnswers)).toBe(true);
    expect(payload.extractionPriorities).toEqual(expect.arrayContaining([
      expect.stringContaining("AI answer engine can quote"),
      expect.stringContaining("customer-entry-point"),
      expect.stringContaining("E-E-A-T")
    ]));
    expect(payload.strategicExposureGuidance).toHaveLength(3);
    expect(payload.strategicExposureGuidance.map((item: Record<string, unknown>) => item.kind)).toEqual(["geo-research", "cep", "eeat"]);
  });

  it("sends CEP narrative, volume isolation, and generative FAQ intent guidance to copy refinement", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ warnings: [] }),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    }));

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });
      await refiner.refineCopy({
        locale: "ko-KR",
        product: {
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "장벽보습 캡슐 토너",
          images: [],
          options: [],
          benefits: ["장벽 보습"],
          effects: [],
          ingredients: ["고밀도 세라마이드 캡슐"],
          usage: [],
          metrics: [],
          faq: [],
          reviews: {
            keywords: ["장벽 보습"],
            items: [
              { body: "10.14 fl. oz. / 300 mL" },
              { body: "촉촉하고 장벽 보습이 잘 느껴져요." },
              { body: "좋아요" },
              { body: "300정" }
            ]
          },
          breadcrumbs: [],
          sourceTexts: ["고밀도 세라마이드 캡슐이 장벽 보습을 돕는다."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage", description: "현재 웹페이지 설명입니다." },
              { "@type": "Product", description: "현재 상품 설명입니다." }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "에스트라 아토베리어365 캡슐 토너",
            description: "현재 상품 설명입니다.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [],
        inferredSearchQueries: [
          {
            kind: "indirect",
            question: "피부가 많이 건조하고 당김이 느껴질 때 어떤 제품을 선택하면 좋나요?",
            keywords: ["수분감", "피부 장벽"],
            answer: "장벽보습 캡슐 토너를 비교할 수 있습니다.",
            source: "review-derived-cep",
            mentionsProductOrBrand: false
          }
        ]
      });

      const instructions = String(capturedBody?.instructions ?? "");
      const input = String(capturedBody?.input ?? "");

      expect(instructions).toContain("volume/size strings");
      expect(instructions).toContain("connected narrative");
      expect(instructions).toContain("네, or 아니요,");
      expect(input).toContain("generativeQueryIntents");
      expect(input).toContain("피부가 많이 건조하고 당김이 느껴질 때");
      expect(input).not.toContain("10.14 fl. oz. / 300 mL");
      expect(input).toContain("촉촉하고 장벽 보습이 잘 느껴져요.");
      expect(input).not.toContain("300정");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries AI Studio copy refinement without temperature and keeps token totals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
          code: "unsupported_value"
        }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaDescriptions: {
                  product: "Hydra Balance Essence highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
                  webPage: "This Hydra Balance Essence page summarizes hydration, barrier support, hyaluronic acid, and usage context."
                },
                contentSections: {
                  description: "Hydra Balance Essence highlights hydration, barrier support, hyaluronic acid, and morning-and-night use."
                },
                warnings: []
              })
            }
          }
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 8
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "aistudio",
        apiKey: "studio-key",
        endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
        deployment: "gpt-5.5",
        temperature: 0
      });
      const result = await refiner.refineCopy({
        locale: "en-US",
        product: {
          name: "Hydra Balance Essence",
          description: "A hydrating essence for dry skin.",
          images: [],
          options: [],
          benefits: ["hydration", "barrier support"],
          effects: [],
          ingredients: ["Hyaluronic Acid"],
          usage: ["Apply morning and night after cleansing."],
          metrics: [],
          faq: [],
          reviews: {
            keywords: [],
            items: []
          },
          breadcrumbs: [],
          sourceTexts: ["Hydra Balance Essence helps skin feel hydrated after cleansing."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                description: "Current webpage description."
              },
              {
                "@type": "Product",
                description: "Current product description."
              }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "Hydra Balance Essence",
            description: "Current product description.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [],
        reasoning: undefined
      });

      const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(firstBody.temperature).toBe(0);
      expect("temperature" in retryBody).toBe(false);
      expect(result.usage?.inputTokens).toBe(13);
      expect(result.usage?.outputTokens).toBe(8);
      expect(result.usage?.totalTokens).toBe(21);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("selects package GEO, CEP, and E-E-A-T RAG chunks during generation", async () => {
    // Capture only the first (initial) call's payload: this mock's fixed response appends a
    // concrete usage step to Product.description, which triggers a corrective retry pass. The
    // retry intentionally sends a reduced payload without hydratedRagDocuments/strategicFullDocuments
    // (see copy-refiner.ts), so capturing a later call here would no longer reflect the primary
    // RAG-selection payload this test is actually about.
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (!capturedBody) {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      }
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaDescriptions: {
            product: "Hydra Barrier Serum is a serum for dry-feeling skin that highlights barrier support, niacinamide, ceramide, and morning-and-night use.",
            webPage: "This Hydra Barrier Serum page summarizes barrier support, niacinamide, ceramide, usage, and review language for comparison-ready product evaluation."
          },
          contentSections: {
            description: "Hydra Barrier Serum is a serum for dry-feeling skin with niacinamide, ceramide, and lightweight review language."
          },
          warnings: []
        }),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      }), { status: 200 });
    }));

    try {
      const { result } = await generatePdpGeo({
        source: {
          type: "manual-json",
          url: "https://example.com/hydra-barrier-serum"
        },
        hints: {
          locale: "en-US",
          market: "US",
          updateTargets: ["faq", "howToUse"]
        },
        product: {
          name: "Hydra Barrier Serum",
          brand: "Example Beauty",
          category: "Skincare Serum",
          description: "A lightweight serum for dry-feeling skin and barrier support.",
          benefits: ["hydration", "skin barrier support"],
          ingredients: ["Niacinamide", "Ceramide"],
          usage: ["Apply morning and night after toner."],
          reviews: {
            keywords: ["lightweight", "absorbs quickly", "comfortable for dry-feeling skin"],
            items: [{ body: "It absorbs quickly and feels lightweight after toner.", rating: 5 }]
          }
        },
        rag: {
          maxChunks: 12,
          scoreThreshold: 0,
          queryPlanning: {
            enabled: true,
            updateTargets: ["faq", "howToUse"]
          }
        }
      }, {
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });

      const selectedKinds = result.diagnostics.selectedRagChunks.map((chunk) => chunk.kind);
      const payload = JSON.parse(String(capturedBody?.input ?? "{}")) as Record<string, any>;
      const strategicKinds = payload.strategicExposureGuidance.map((item: Record<string, unknown>) => item.kind);
      const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);
      const fullDocumentKinds = payload.strategicFullDocuments.map((item: Record<string, unknown>) => item.kind);

      expect(result.diagnostics.ragQueryPlan?.mode).toBe("agentic-subquery-planning");
      expect(result.diagnostics.ragQueryPlan?.queries.map((query) => query.target)).toEqual(expect.arrayContaining(["faq", "howToUse"]));
      expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(strategicKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(fullDocumentKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "eeat")?.content)
        .toContain("Trust-First Claim Safety");
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "cep")?.content)
        .toContain("CEP Identification and Prioritization");
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "geo-research")?.content)
        .toContain("Research-Backed GEO Principles");
      expect(payload.hydrationPolicy).toEqual(expect.arrayContaining([
        expect.stringContaining("Selected chunks are the highest-priority")
      ]));
      expect(result.diagnostics.evidence.some((item) => item.field === "copy.refinement" && item.value.includes("GEO research, CEP, and E-E-A-T"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps GEO, CEP, and E-E-A-T coverage under single-query retrieval with eight final chunks", async () => {
    const { result } = await generatePdpGeo({
      source: {
        type: "manual-json",
        url: "https://example.com/products/gentle-cleansing-foam"
      },
      hints: {
        locale: "en-US",
        market: "US"
      },
      product: {
        name: "Gentle Cleansing Foam",
        brand: "Sulwhasoo",
        category: "Cleansing Foam",
        description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
        benefits: ["hydration", "removes impurities"],
        ingredients: ["Hydro-cleansing formula"],
        usage: ["Lather with water, massage onto damp skin, and rinse with lukewarm water."],
        reviews: {
          keywords: [],
          items: []
        }
      },
      rag: {
        maxChunks: 8,
        scoreThreshold: 0
      }
    });

    const selectedKinds = result.diagnostics.selectedRagChunks.map((chunk) => chunk.kind);
    const selectedSources = result.diagnostics.selectedRagChunks.map((chunk) => chunk.source);
    const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);
    const reasoningSources = result.diagnostics.reasoning?.decisions.flatMap((decision) => decision.ragSources) ?? [];

    expect(result.diagnostics.ragQueryPlan?.mode).toBe("single-query");
    expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    expect(selectedSources).toEqual(expect.arrayContaining([
      pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo
    ]));
    expect(selectedSources).not.toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(selectedSources).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.aestura);
    expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    expect(reasoningSources).toEqual(expect.arrayContaining([
      expect.stringContaining("geo-research"),
      expect.stringContaining("cep"),
      expect.stringContaining("eeat"),
      expect.stringContaining(pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo),
      expect.stringContaining(pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo)
    ]));
    expect(result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "reranking")?.details)
      .toContain("contextual hybrid reranking");
  });

  it("uses OCR sentence insights to enrich effect, ingredient, full ingredient, and schema notes", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Concentrated Ginseng Rejuvenating Serum",
          description: "A serum with Korean Ginseng Actives.",
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
                  text: "This advanced formula, working synergistically with Korean Ginseng Actives, enhances skin firmness, elasticity, and resilience, helping to diminish visible signs of aging.",
                  keywords: ["Korean Ginseng Actives", "firmness", "elasticity", "resilience"]
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
    const positiveNotes = product.positiveNotes.itemListElement as Array<Record<string, any>>;
    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(result.content.sections.description).toMatch(/supports|formula|texture|routine|visible benefits|key actives|comfort/);
    expect(result.content.sections.description).not.toContain("This advanced formula, working synergistically");
    expect(result.content.sections.description).not.toContain("concise ingredient/effect claim for product comparison");
    expect(result.content.sections.ingredients).toContain("Ginseng Peptide");
    expect(result.content.sections.ingredients).toContain("Full ingredients: WATER / AQUA / EAU");
    expect(additionalProperties.some((item) => item.name === "Ingredient/effect detail" && /formula|texture|routine|benefit|comfort/.test(String(item.value)))).toBe(true);
    expect(additionalProperties.some((item) => item.name === "Full ingredients")).toBe(false);
    expect(positiveNotes.map((item) => item.name)).toEqual(expect.arrayContaining(["skin resilience", "elasticity", "firmness"]));
    expect(ocrDiagnostics.find((item) => item.text.includes("6-peptide blend"))?.imageUrls).toEqual(["https://example.com/ginseng-peptide.jpg"]);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toMatch(/ingredient\/effect claim|Citation highlight|citation highlight|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
  });

  it("classifies raw OCR image text into varied Korean ingredient and benefit schema content", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 수딩 크림입니다.",
          brand: "AESTURA",
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
                  imageUrl: "https://example.com/aestura-hero.jpg",
                  lines: [
                    "아토베리어365",
                    "하이드로 수딩크림",
                    "민감하고 수분이 부족한 지성 피부의",
                    "유수분 밸런스를 맞추고",
                    "속수분을 채워주는 장벽수분 캡슐크림"
                  ]
                },
                {
                  imageUrl: "https://example.com/aestura-ingredients.jpg",
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
    expect(ocrDiagnostics.find((item) => item.text.includes("압축 히알루론산"))?.imageUrls).toEqual(["https://example.com/aestura-ingredients.jpg"]);
    expect(ocrDiagnostics.every((item) => item.text.length > 0 && item.schemaFields.length > 0 && item.geoUse.length > 0)).toBe(true);
    expect(serialized).not.toMatch(/효능어|성분어|사용감어|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|제품 탐색 문맥|탐색 문맥에서/);
  });

  it("reconstructs English OCR heading and body lines as semantic sentences", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Cream",
          description: "A lightweight cream for hydration and skin barrier support.",
          brand: "AESTURA",
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
    expect(result.content.sections.faq).toMatch(/Compressed Hyaluronic Acid|Zinc|High-density Ceramide Capsule/);
    expect(result.content.sections.faq).not.toMatch(/What does .* explain about|OCR|citation/i);
  });

  it("keeps varied Korean GEO content from existing product, RAG, and review data when OCR is absent", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 산뜻한 장벽 수분 크림입니다.",
          brand: "AESTURA",
          category: "Cream",
          benefits: ["수분감", "피부 장벽", "유분 컨트롤", "산뜻한 사용감"],
          effects: ["수분감을 높인 워터 크림 제형으로 피부에 닿을 때 시원하고 산뜻한 쿨링감을 제공합니다."],
          ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "징크"],
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."],
          reviews: {
            keywords: ["수분감", "산뜻함", "피부결", "촉촉한 사용감"],
            items: [
              { body: "가볍게 발리고 수분감이 오래 남아서 지성 피부에도 부담이 적어요.", rating: 5 },
              { body: "피부결이 매끈해 보이고 산뜻해서 아침 루틴에 쓰기 좋아요.", rating: 5 }
            ]
          }
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
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
              "- Compose benefit statements from target customer, product identity, ingredient or technology, benefit/effect or metric, and high-level usage/review context.",
              "- If OCR evidence is not present, use existing mapped product facts, selected RAG chunks, and customer review language to keep descriptions, benefits, HowTo, and FAQ varied."
            ].join("\n")
          }
        ]
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.diagnostics.ocrSentences).toHaveLength(0);
    expect(result.content.sections.benefits).toMatch(/수분감|피부 장벽|유분 컨트롤|산뜻한 사용감/);
    expect(result.content.sections.benefits).toMatch(/압축 히알루론산|고밀도 세라마이드 캡슐|징크|리뷰 표현|사용감 맥락|루틴/);
    expect(result.content.sections.faq).toMatch(/압축 히알루론산|수분감|피부 장벽|산뜻함|피부결|촉촉한 사용감/);
    expect(result.content.sections.howToUse).toContain("아침과 저녁 스킨케어 마지막 단계");
    expect(result.content.sections.quickFacts).toMatch(/주요 성분|고객 리뷰|비교할 때/);
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.sections.benefits).not.toContain("상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다.");
    expect(serialized).not.toMatch(/OCR|What does .* explain|인용|상품 상세의 압축 히알루론산 설명/);
  });

  it("reconstructs HowTo and FAQ with selected GEO RAG guidance instead of exposing raw source text only", async () => {
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
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.howToUse).toContain("Apply morning and night after serum");
    expect(result.content.sections.howToUse).not.toContain("hydration");
    expect(result.content.sections.howToUse.trim()).toBe("1. Apply morning and night after serum");
    expect(result.content.sections.faq).toContain("How should Ginseng Barrier Serum be used?");
    expect(result.content.sections.faq).toContain("What do customer reviews highlight about Ginseng Barrier Serum?");
    expect(result.content.sections.faq).toContain("Niacinamide");
    expect(result.content.sections.faq).not.toContain("Product details");
    expect(result.content.sections.faq).not.toContain("Product detail context");
    expect(result.content.sections.faq).not.toContain("Available product information");
    expect(result.content.sections.faq).not.toContain("Evidence signal");
    expect(result.content.sections.faq).not.toContain("Review signals");
    expect(serialized).not.toMatch(/Evidence signal|Review signals|technology signals|main benefit signal|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
    expect(result.content.sections.faq).not.toContain("Can I use it daily?");
    expect(result.content.sections.faq).not.toContain("A. Apply morning and night after serum.");
    expect(howTo.step[0].text).toBe("Apply morning and night after serum");
    expect(howTo.step[0].name).toBe("Step 1");
    expect(faq.mainEntity.some((item: any) => item.name === "How should Ginseng Barrier Serum be used?")).toBe(true);
    expect(faq.mainEntity.some((item: any) => item.name === "Can I use it daily?")).toBe(false);
    expect(faq.mainEntity.some((item: any) => item.name === "What do customer reviews highlight about Ginseng Barrier Serum?")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "rag.geoOptimizationGuidance")).toBe(true);
    expect(result.diagnostics.recommendations.some((item) => item.field === "faq")).toBe(true);
    expect(result.diagnostics.ragUsage.length).toBeGreaterThan(0);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "answer-ready FAQ" && item.references.some((reference) => reference.fieldTargets.includes("FAQPage.mainEntity")))).toBe(true);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "stepwise HowTo" && item.references.some((reference) => reference.fieldTargets.includes("HowTo.step")))).toBe(true);
  });

  it("derives review-backed CEP recommendation PropertyValues from positive reviews while excluding negative review complaints", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "자음생크림",
        description: "인삼 사포닌과 콜라겐을 담아 피부 탄력과 보습 케어를 돕는 프리미엄 크림입니다.",
        brand: "설화수",
        category: "크림",
        benefits: ["탄력", "주름", "보습", "윤기"],
        ingredients: ["인삼 사포닌", "콜라겐"],
        reviews: {
          keywords: ["탄력", "주름", "윤기", "선물"],
          items: [
            {
              body: "40대가 되니 피부 탄력과 주름이 신경 쓰였는데 바르고 나면 피부가 쫀쫀하고 윤기가 돌아요.",
              rating: 5
            },
            {
              body: "명절마다 어머니 선물로 드리는데 고급스럽고 촉촉해서 좋아하세요.",
              rating: 5
            },
            {
              body: "향이 강해서 아쉬워요.",
              rating: 2
            }
          ]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/jaseng-cream"
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        brand: "설화수"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;
    const reviewCepProperties = properties.filter((item) =>
      item.name === "Review-derived recommendation context"
    );
    const reviewQueryProperties = properties.filter((item) =>
      item.name === "Indirect customer question" || item.name === "Direct product question"
    );
    const serialized = JSON.stringify(reviewCepProperties);
    const querySerialized = JSON.stringify(reviewQueryProperties);
    const faqQuestions = faq.mainEntity.map((item: Record<string, any>) => item.name);

    expect(reviewCepProperties.length).toBeGreaterThanOrEqual(2);
    expect(reviewCepProperties.every((item) => item.propertyID === "reviewDerivedRecommendationContext")).toBe(true);
    expect(reviewCepProperties.map((item) => String(item.name)).join(" ")).not.toMatch(/피부 탄력과 주름|가족이나 지인에게 선물|피부가 푸석하고 윤기/);
    expect(serialized).toContain("자음생크림");
    expect(serialized).toContain("추천할 수 있는 크림");
    expect(serialized).toContain("고객 리뷰");
    expect(serialized).toContain("인삼 사포닌");
    expect(serialized).toContain("탄력");
    expect(serialized).not.toMatch(/CEP|향이 강|아쉬워요|rating|별점|프리미엄 크림입니다\\.,/);
    expect(reviewQueryProperties.length).toBeGreaterThanOrEqual(2);
    expect(querySerialized).toContain("피부 탄력과 주름이 신경 쓰이기 시작할 때 어떤 크림을 선택하면 좋나요?");
    expect(querySerialized).toContain("설화수 자음생크림의 주요 성분과 효능은 무엇인가요?");
    expect(querySerialized).toContain("인삼 사포닌");
    expect(reviewQueryProperties.map((item) => String(item.name)).join(" ")).not.toMatch(/어떤 크림을 선택하면 좋나요|주요 성분과 효능은 무엇인가요|리뷰에서 반복되는 사용감/);
    expect(reviewQueryProperties.some((item) => item.propertyID === "indirectCustomerQuestion")).toBe(true);
    expect(reviewQueryProperties.some((item) => item.propertyID === "directProductQuestion")).toBe(true);
    expect(querySerialized).not.toMatch(/간접 고객 질문|직접 상품 질문|핵심 키워드|CEP|Search intent context|향이 강|아쉬워요|rating|별점/);
    expect(faqQuestions).toContain("피부 탄력과 주름이 신경 쓰이기 시작할 때 어떤 크림을 선택하면 좋나요?");
    expect(faqQuestions).toContain("설화수 자음생크림의 주요 성분과 효능은 무엇인가요?");
    expect(faqQuestions).not.toContain("설화수 자음생크림은 어떤 피부 고민과 효능에 적합한가요?");
    expect(faqQuestions.filter((question: string) => /주요 성분과 효능|피부 고민과 효능/.test(question))).toEqual([
      "설화수 자음생크림의 주요 성분과 효능은 무엇인가요?"
    ]);
    expect(result.diagnostics.inferredSearchQueries?.length).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.inferredSearchQueries?.some((query) =>
      query.kind === "indirect"
      && query.question === "피부 탄력과 주름이 신경 쓰이기 시작할 때 어떤 크림을 선택하면 좋나요?"
      && query.mentionsProductOrBrand === false
    )).toBe(true);
    expect(result.diagnostics.inferredSearchQueries?.some((query) =>
      query.kind === "direct"
      && query.question === "설화수 자음생크림의 주요 성분과 효능은 무엇인가요?"
      && query.mentionsProductOrBrand === true
      && query.keywords.includes("인삼 사포닌")
    )).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "diagnostics.inferredSearchQueries")).toBe(true);
  });

  it("keeps positiveNotes and benefit context free of marketing fragments and clinical sample fragments", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "A serum formulated with Korean Ginseng Actives and Retinol for visible plumpness and firmness.",
        category: "Serum",
        benefits: [
          "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives™ and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles, while delivering essential nutrients."
        ],
        effects: [
          "After 6 weeks of use 100% of users showed improvement in: Fine Lines & Wrinkles* Elasticity* Firmness* *Instrumental result, 32 women"
        ],
        ingredients: ["Korean Ginseng Actives™", "Retinol"],
        usage: [
          "Use morning and night, after applying toner. Warm three pumps between fingers and apply to your face and neck with upward motions.",
          "Warm three pumps of serum between fingers and apply to your face and neck with upward motions."
        ],
        reviews: {
          keywords: ["smooth", "moisture", "firmness"],
          items: [
            { body: "My skin feels smoother and firmer, and the serum absorbs without heaviness.", rating: 5 }
          ]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/concentrated-ginseng-rejuvenating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const notes = product.positiveNotes.itemListElement.map((item: any) => item.name);
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(notes).toEqual(expect.arrayContaining(["fine lines and wrinkles", "elasticity", "firmness", "plumpness"]));
    expect(webPage.description).toContain("introduces the serum for customers");
    expect(webPage.description).toContain("fine lines and wrinkles");
    expect(webPage.description).toContain("Korean Ginseng Actives");
    expect(webPage.description).toContain("This product page covers");
    expect(webPage.description).toContain("routine use, including morning and night after toner");
    expect(webPage.description).not.toMatch(/The page states that|The page helps answer|helps answer|Usage guidance covers|product-detail evidence/i);
    expect(webPage.description).toContain("smooth");
    expect(product.description).toContain("fine lines and wrinkles");
    expect(product.description).toContain("Korean Ginseng Actives");
    expect(product.description).toContain("Retinol");
    expect(product.description).toContain("morning and evening post-toner routine");
    expect(product.description).not.toContain("then warm three pumps");
    expect(product.description).not.toContain("aroun…");
    expect(product.description).not.toContain("making the benefit and ingredient story understandable");
    expect(product.description).not.toContain("product page");
    expect(product.description).toContain("Representative customer reviews describe it as");
    expect(product.description).toContain("My skin feels smoother and firmer");
    expect(product.description).toContain("repeated review language such as");
    expect(product.description).toContain("smooth");
    expect(product.description).toContain("moisture");
    expect(product.description).toContain("firmness");
    expect(product.description).toContain("100% of users showed improvement");
    expect(product.description).not.toContain("Source information includes 6 weeks");
    expect(webPage.description).not.toBe(product.description);
    expect(notes.some((name: string) => /Formulated with|while delivering|32 women|Instrumental result/i.test(name))).toBe(false);
    expect(serialized).not.toContain("Formulated with our advanced capsule technology routine");
    expect(serialized).not.toContain("\"name\":\"32 women\"");
    expect(howTo.step).toHaveLength(2);
  });

  it("normalizes uppercase self-assessment result fragments before using them in descriptions", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "A ginseng serum for firmness, elasticity, and fine lines.",
        category: "Serum",
        benefits: ["fine lines and wrinkles", "firmness", "elasticity"],
        effects: [
          "100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC2 100% AGREED SKIN TEXTURE FEELS IMPROVED AND MORE EVEN2 93% AGREED FINE LINES AND WRINKLES FEEL DIMINISHED2 2Self-assessment test conducted 6 weeks after use on 32 women"
        ],
        ingredients: [
          "KOREAN GINSENG ACTIVES (AKA GINSENOMICS ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng",
          "Ginseng Peptide - Helps support the look of skin firmness and elasticity, synergistically enhancing the benefits of Korean Ginseng Actives"
        ],
        usage: ["Use morning and night, after applying toner."],
        reviews: {
          keywords: ["smooth", "firmness"]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/concentrated-ginseng-rejuvenating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify({ webPage, product, faq });
    const productSerialized = JSON.stringify(product);
    const additionalProperties = new Map(product.additionalProperty.map((item: any) => [item.name, item.value]));
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name);

    expect(webPage.description).toContain("reported results for firmness and visible-aging care");
    expect(product.description).toContain("Korean Ginseng Actives (Ginsenomics), a patented ingredient described as amplifying rare ginseng compounds");
    expect(product.description).toContain("Ginseng Peptide, described as supporting the look of skin firmness and elasticity");
    expect(product.description).toContain("morning and evening post-toner routine");
    expect(product.description).not.toContain("then warm three pumps");
    expect(product.description).not.toContain("Customer reviews mention smooth and firmness");
    expect(product.description).toContain("In a self-assessment of 32 women after 6 weeks of use, the product showed firmness and visible-aging care");
    expect(product.description).not.toMatch(/Reported self-assessment|evidence covers|Product details evidence/i);
    expect(product.description).not.toContain("Reported product details include In a");
    expect(product.description).not.toContain("product page");
    expect(product.description).not.toContain("…");
    expect(product.additionalProperty.some((item: any) => item.name === "Quick facts")).toBe(false);
    expect(product.additionalProperty.some((item: any) => /\\n|\n/.test(String(item.value)))).toBe(false);
    expect(additionalProperties.get("Target customer")).toContain("customers");
    expect(additionalProperties.get("Key benefit")).toBe("fine lines and wrinkles");
    expect(additionalProperties.get("Reported details")).toContain("In a self-assessment of 32 women after 6 weeks of use");
    expect(additionalProperties.get("Reported details")).not.toMatch(/elastic2|even2|diminished2|\(32 women\)/i);
    expect(additionalProperties.get("Key ingredients")).toContain("Korean Ginseng Actives (Ginsenomics), Ginseng Peptide");
    expect(positiveNotes).toEqual(expect.arrayContaining(["fine lines and wrinkles", "firmness", "elasticity"]));
    expect(productSerialized).not.toContain("AGREED");
    expect(productSerialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
    expect(productSerialized).not.toContain("\\n");
    expect(serialized).not.toContain("AGREED");
    expect(serialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
  });

  it("keeps first-care style home-usage OCR evidence grounded and removes weak CEP expansion", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "First Care Activating Serum VI",
        description: "A ginseng-powered serum for hydration, visible firmness, fine lines, dullness, and skin texture.",
        category: "Serum",
        benefits: ["hydration", "elasticity", "improves hydration", "smooth texture"],
        effects: [
          "92% AGREE SKIN LOOKS CLEAR AND BRIGHT3 86% AGREE FINE LINES LOOK REDUCED3 96% AGREE SKIN TEXTURE FEELS SMOOTHER3 3Home usage test survey, 600 women, with daily use.",
          "AFTER ONE BOTTLE OF DAILY USE*: 100% users had visible improvement in FINE LINES SKIN ELASTICITY DULLNESS *Instrumental result, 30 subjects, after 8 weeks of daily use FIRST CARE ACTIVATING SERUM VI SÉRUM ACTIVATEUR VI PREMIERS SOINS Sulwhasoo"
        ],
        metrics: [
          "+5.9% IMPROVES THE LOOK OF SKIN ELASTICITY4 +9.9% STRENGTHENS MOISTURE BARRIER4 +14.5% INCREASES HYDRATION4 4Instrumental result, 30 women, after 4 weeks of use"
        ],
        ingredients: [
          "GINSENG",
          "with the power of ginseng",
          "KEY INGREDIENTS: 500-HOURFERMENTED GINSENG*: Supports a healthy skin barrier, helping visibly improve fine lines and wrinkles.",
          "500-HOUR AGED GINSENG: Supports the skin barrier and helps improve visible fine lines and wrinkles.",
          "KOREAN HERB EXTRACT: Improves hydration, visibly firms, and addresses visible signs of aging."
        ],
        usage: ["Warm 2-3 pumps of First Care Activating Serum to the palm of your hands, then apply morning and night."],
        reviews: {
          keywords: ["hydration", "firmness"]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/first-care-activating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const additionalProperties = new Map(product.additionalProperty.map((item: any) => [item.name, item.value]));
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name);
    const reportedDetails = String(additionalProperties.get("Reported details"));
    const serialized = JSON.stringify({ webPage, product, faq });

    expect(additionalProperties.get("Target customer")).toContain("visible-aging");
    expect(additionalProperties.get("Key ingredients")).toContain("500-hour aged ginseng");
    expect(additionalProperties.get("Key ingredients")).toContain("Korean herb extract");
    expect(additionalProperties.get("Key ingredients")).not.toMatch(/with the power of ginseng|^GINSENG(?:,|$)/i);
    expect(additionalProperties.get("Ingredient/effect detail")).toContain("The formula uses 500-hour aged ginseng and Korean herb extract to support");
    expect(additionalProperties.get("Ingredient/effect detail")).toContain("selection cue for customers comparing visible-aging");
    expect(additionalProperties.get("Ingredient/effect detail")).not.toMatch(/and fine lines and wrinkles and skin barrier support|SÉRUM|ACTIVATEUR|AFTER ONE BOTTLE/i);
    expect(additionalProperties.get("Reported details")).toContain("In a home usage test survey of 600 women with daily use");
    expect(additionalProperties.get("Reported details")).toContain("92% of participants agreed that skin looks clear and bright");
    expect(additionalProperties.get("Reported details")).toContain("86% of participants agreed that fine lines look reduced");
    expect(additionalProperties.get("Reported details")).toContain("96% of participants agreed that skin texture felt smoother");
    expect(reportedDetails).toContain("+5.9% improvement in the look of skin elasticity");
    expect(reportedDetails).toContain("+9.9% strengthened moisture barrier");
    expect(reportedDetails).toContain("+14.5% increased hydration");
    if (/8 weeks/i.test(String(webPage.description))) {
      expect(reportedDetails).toMatch(/8 weeks/i);
    }
    expect(positiveNotes.filter((name: string) => /hydration|improves hydration/i.test(name))).toHaveLength(1);
    expect(serialized).not.toMatch(/\bAGREE\b|3Home|SÉRUM|ACTIVATEUR|AFTER ONE BOTTLE|oil-control|sensitive-skin|\+5\. 9|\+9\. 9|\+14\. 5|\b9% agreed|\b5% agreed/i);
    expect(serialized).not.toContain("KEY INGREDIENTS");
  });

  it("cleans Korean Aestura-style OCR, review typos, and property chunks before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감 피부를 위한 산뜻한 수분 크림입니다.",
          brand: "AESTURA",
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
            "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
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
            "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            "https://images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp"
          ],
          reviews: {
            keywords: ["피부결", "만족합니다", "촉촉하고", "보습력도", "smooth texture"],
            items: [
              {
                body: "에스트라는 그냥 너무 좋아요 많은 말도 필요없고 속단김이나 건조함 잡는데는 정말 좋나요 메이크업 전에 무거운 베이스가 싫은데 에스트라는 아주 가벼우면서도 건조함을 잘 채워줘서 좋어요 모든 베이스 라인을 다 에스트라로 바꿀 정도니까 말할것도 없네요 리뉴널 욘기조 너무 예뻐요 만족합니다",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1148"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const reportedDetails = additionalProperties.find((item) => item.name === "Reported details")?.value;
    const usageContext = additionalProperties.find((item) => item.name === "Usage")?.value;
    const reviewUseFeelContext = additionalProperties.find((item) => item.name === "Customer review context")?.value;
    const reviewBodies = product.review.map((review: any) => review.reviewBody).join(" ");
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name).join(" ");
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const normalized = result.diagnostics.normalizedProduct;

    expect(result.content.sections.productName).toBe("에스트라 아토베리어365 하이드로 수딩크림");
    expect(product.name).toBe("에스트라 아토베리어365 하이드로 수딩크림");
    expect(product.category).toBe("크림");
    expect(webPage.description).toContain("수분감");
    expect(product.description).toMatch(/세라마이드|히알루론산/);
    expect(product.description).toMatch(/핵심 성분\/기술|사용감 표현/);
    expect(product.description).not.toContain("\", \"");
    expect(product.description).not.toContain("대표 고객 리뷰에서는 \"");
    expect(product.description).not.toMatch(/성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|합니다입니다|습니다입니다|입니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
    expect(result.content.sections.quickFacts).toMatch(/주요 성분|비교할 때|고객 리뷰/);
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.sections.benefits).toMatch(/선택 기준|사용감 판단|핵심 효능|루틴|체감 장점|뒷받침/);
    expect(result.content.sections.benefits).toContain("사용감 판단");
    expect(result.content.sections.benefits).not.toMatch(/케어 케어|설명은/);
    expect(result.content.sections.ingredients).toMatch(/고밀도 세라마이드 캡슐|히알루론산|수분감|피부 장벽|리뷰 표현|루틴/);
    expect(result.content.sections.faq).toMatch(/선택하기 좋은 크림|뒷받침합니다|성분적 배경/);
    expect(result.content.sections.faq).not.toMatch(/상품 상세의|상품 상세 근거/);
    expect(result.content.sections.faq).toMatch(/수분감|장벽 케어|유분 컨트롤|피부 고민/);
    expect(result.content.sections.faq).not.toMatch(/성분 설명은|확인 키워드|성분 역할, 수분감, 사용감, 피부 고민 선택 기준|포인트입니다 결과|성분 근거와 효능 맥락|성분 역할과 기대 효능의 비교 기준을 제시합니다|What does|OCR|인용/);
    expect(result.content.sections.faq).toContain("고객 리뷰는 에스트라 아토베리어365 하이드로 수딩크림의 어떤 사용감을 강조하나요?");
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
    expect(positiveNotes).toContain("수분감");
    expect(positiveNotes).toContain("피부결");
    expect(positiveNotes).not.toMatch(/hydration|smooth texture|만족합니다|촉촉하고|리뉴얼 전 제품/);
    expect(normalized.benefits.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|각 크림에는|리뉴얼 전 제품에서 고객님들이 만족/);
    expect(normalized.effects.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분/);
    expect(normalized.ingredients.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요|캡슐이 있어서 좋은 이유는 무엇인가요|^성분$/);
    expect(normalized.usage.join(" ")).not.toMatch(/여드름성 피부가 사용해도 괜찮은가요|영유아나 임산부가 사용해도 되나요|논코메도제닉 테스트를 완료/);
    expect(normalized.usage).toEqual(["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."]);
    expect(normalized.faq.some((item) => item.question === "쿨링 효과는 어떤 성분이 해주는 것인가요?" && item.answer.includes("시원하고 산뜻한 쿨링감"))).toBe(true);
    expect(normalized.faq.some((item) => item.question === "여드름성 피부가 사용해도 괜찮은가요?" && item.answer.includes("논코메도제닉 테스트"))).toBe(true);
    expect(result.diagnostics.ocrSentences.every((item) => !/문장입니다|재구성합니다|활용합니다/.test(item.geoUse))).toBe(true);
    expect(serialized).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|인용 포인트|Citation highlight|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|성분\/기술은\s*[^.]*맞물려 제품 특징을 구체화합니다|…|\.{3,}|hydration Cream|smooth texture|property value|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/i);
    expect(additionalProperties.every((item) => !String(item.value).endsWith("?"))).toBe(true);
  });

  it("runs final Korean sentence QA over schema markup and content artifacts", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "테스트 수딩 크림",
      fallbackDescription: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              "@id": "https://example.com/product#webpage",
              url: "https://example.com/product",
              name: "테스트 수딩 크림",
              description: "테스트 수딩 크림 상품 페이지는 고객이 크림을 비교할 때 필요한 정보를 정리합니다. 확인된 결과/정보로 https: //images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp를 참고할 수 있습니다."
            },
            {
              "@type": "Product",
              "@id": "https://example.com/product#product",
              name: "테스트 수딩 크림",
              description: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다. 확인된 상품 정보는 고밀도 세라마이드 캡슐, 히알루론산 성분/기술은 피부 장벽 효능 맥락과 연결되어 크림 비교에 필요한 핵심 케어 근거를 설명합니다입니다. 쿨링을 주는 성분은 ... 설계되었습니다. 대표 고객 리뷰에서는 \"너무 예뻐요 만족합니다\", \"믿고 쓰는 브랜드 피부에 수분감이 많아서 좋아요\"처럼 설명되며, 피부결를 같은 반복 표현도 함께 확인됩니다.",
              review: [
                {
                  "@type": "Review",
                  reviewBody: "속단김이나 건조함에는 정말 좋나요 메이크업 전에 쓰기 좋어요. 리뉴널 욘기조 예뻐요."
                }
              ],
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Key ingredients",
                  value: "히알루론산, 각 크림에는 피부타입과 피부고민을 고려한 캡슐이 함유되어 있습니다.캡슐은 장벽을 튼튼하게 …"
                },
                {
                  "@type": "PropertyValue",
                  name: "Reported details",
                  value: "https: //images-kr. amoremall. com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867. jpg? format=webp"
                },
                {
                  "@type": "PropertyValue",
                  name: "Ingredient/effect detail",
                  value: "고밀도 세라마이드 캡슐, 히알루론산 성분/기술은 피부 장벽 효능 맥락과 연결되어 크림 비교에 필요한 핵심 케어 근거를 설명합니다"
                },
                {
                  "@type": "PropertyValue",
                  name: "Key benefit",
                  value: "수분감를"
                }
              ],
              positiveNotes: {
                "@type": "ItemList",
                itemListElement: [
                  { "@type": "ListItem", position: 1, name: "피부결를" },
                  { "@type": "ListItem", position: 2, name: "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감" }
                ]
              }
            },
            {
              "@type": "FAQPage",
              "@id": "https://example.com/product#faq",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "테스트 수딩 크림은 어떻게 사용하면 좋나요?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "확인 가능한 정보로 고객 리뷰 표현: 피부결를 포함합니다."
                  }
                },
                {
                  "@type": "Question",
                  name: "에스트라 아토베리어365 하이드로 수딩크림 정보는 무엇으로 확인할 수 있나요?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "고밀도 세라마이드 캡슐과 히알루론산은 민감한 피부 루틴을 찾는 고객에게 피부 장벽, 수분감, 쿨링감, 피부결 케어의 성분적 배경을 제공하는 포인트입니다. 고객 리뷰의 피부결, 만족도, 촉촉한 사용감 표현은 사용감과 케어 포인트를 구체화합니다."
                  }
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "테스트 수딩 크림",
          description: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다. 쿨링을 주는 성분은 ... 설계되었습니다.",
          quickFacts: "핵심 효능: 수분감를\n확인된 정보: https: //images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp",
          benefits: "- 피부결를\n- 리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감",
          ingredients: "- 히알루론산\n- 각 크림에는 ... 장벽을 튼튼하게 …",
          howToUse: "1. 얼굴 전체에 부드럽게 펴 바릅니다.",
          faq: "Q. 테스트 수딩 크림은 어떻게 사용하면 좋나요?\nA. 확인 가능한 정보로 고객 리뷰 표현: 피부결를 포함합니다."
        },
        html: "<div class=\"geo-content-accordion\"><script>alert(1)</script></div>"
      }
    });

    const serialized = JSON.stringify(repaired.schemaMarkup.jsonLd);
    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const productProperties = product.additionalProperty as Array<Record<string, any>>;
    const notes = product.positiveNotes.itemListElement as Array<Record<string, any>>;

    expect(serialized).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|확인된 상품 정보는|핵심 케어 근거|…|\.{3,}|수분감를|피부결를|너무 예뻐요 만족합니다", "믿고 쓰는|동일한 캡슐인가요\?|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
    expect(serialized).not.toMatch(/성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서/);
    expect(product.description).toContain("수분감을");
    expect(product.description).toContain("고밀도 세라마이드 캡슐과 히알루론산은 피부 장벽 케어를 뒷받침하는 크림의 핵심 포인트");
    expect(product.review[0].reviewBody).toContain("속단김");
    expect(product.review[0].reviewBody).toContain("좋어요");
    expect(product.review[0].reviewBody).toContain("리뉴널 욘기조");
    expect(productProperties.some((item) => item.name === "Reported details")).toBe(false);
    expect(productProperties.some((item) => item.name === "Key ingredients")).toBe(false);
    expect(productProperties.find((item) => item.name === "Ingredient/effect detail")?.value).toContain("크림의 핵심 포인트입니다");
    expect(productProperties.find((item) => item.name === "Key benefit")?.value).toBe("수분감");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.name).toBe("피부결");
    expect(faq.mainEntity.some((item: any) => item.name === "테스트 수딩 크림은 어떻게 사용하면 좋나요?")).toBe(false);
    const repairedMismatchFaq = faq.mainEntity.find((item: any) => item.name.includes("성분, 효능, 사용감"));
    expect(repairedMismatchFaq?.name).toBe("에스트라 아토베리어365 하이드로 수딩크림의 성분, 효능, 사용감은 어떤 정보로 정리되나요?");
    expect(repairedMismatchFaq?.acceptedAnswer.text).toContain("피부 장벽, 수분감, 쿨링감, 피부결");
    expect(repairedMismatchFaq?.acceptedAnswer.text).not.toMatch(/고객 리뷰|리뷰 표현|후기/);
    expect(repaired.content.sections.description).toContain("수분감을");
    expect(repaired.content.sections.quickFacts).not.toContain("images-kr.amoremall");
    expect(repaired.content.html).not.toContain("<script>");
    expect(repaired.content.html).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|…|\.{3,}|수분감를|피부결를/);
    expect(repaired.validationWarnings.some((warning) => warning.includes("Final sentence QA repaired"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.description" && String(repair.before).includes("수분감를") && String(repair.after).includes("수분감을"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.html" && String(repair.before).includes("<script>") && String(repair.after).includes("geo-content-accordion"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty" && JSON.stringify(repair.before).includes("Reported details") && repair.after === null)).toBe(true);
  });

  it("repairs duplicated Korean Usage PropertyValue step artifacts", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "에스트라 아토베리어365 바디로션",
      fallbackDescription: "건조 피부를 위한 고보습 바디로션입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/product#product",
              name: "에스트라 아토베리어365 바디로션",
              description: "건조 피부를 위한 고보습 바디로션입니다.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Usage",
                  value: "1단계: 샤워 후 손바닥에 적당량 덜어주세요; 2단계:. 1 샤워 후 손바닥에 적당량 덜어주세요"
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "에스트라 아토베리어365 바디로션",
          description: "건조 피부를 위한 고보습 바디로션입니다.",
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: "1. 샤워 후 손바닥에 적당량 덜어주세요",
          faq: ""
        },
        html: ""
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const usageValue = String((product.additionalProperty as Array<Record<string, any>>)[0]?.value ?? "");

    expect(usageValue).toBe("샤워 후 손바닥에 적당량 덜어주세요");
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty.Usage")).toBe(true);
  });

  it("repairs public FAQ labels, metric decimals, and evidence duration consistency", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "First Care Activating Serum VI",
      fallbackDescription: "First Care Activating Serum VI supports visible-aging care.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "First Care Activating Serum VI",
              description: "First Care Activating Serum VI cites home usage evidence after 4 weeks and 8 weeks of daily use."
            },
            {
              "@type": "Product",
              name: "First Care Activating Serum VI",
              description: "Instrumental results after 4 weeks and 8 weeks of daily use include +5. 9% improvement in skin elasticity.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Reported details",
                  value: "Consumer assessment: +5. 9% improvement in the look of skin elasticity, +9. 9% strengthened moisture barrier, and +14. 5% increased hydration after 4 weeks of use."
                }
              ]
            },
            {
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "KEY INGREDIENTS",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "KEY INGREDIENTS details mention fermented ginseng."
                  }
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "First Care Activating Serum VI",
          description: "First Care Activating Serum VI supports visible-aging care.",
          quickFacts: "Reported details: +5. 9% improvement in skin elasticity.",
          benefits: "Visible-aging care",
          ingredients: "Fermented ginseng",
          howToUse: "Apply morning and night.",
          faq: "Q. KEY INGREDIENTS\nA. KEY INGREDIENTS details mention fermented ginseng."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const reportedDetails = String(product.additionalProperty[0].value);
    const serialized = JSON.stringify(repaired.schemaMarkup.jsonLd);

    expect(reportedDetails).toContain("+5.9% improvement in the look of skin elasticity");
    expect(reportedDetails).toContain("+9.9% strengthened moisture barrier");
    expect(reportedDetails).toContain("+14.5% increased hydration");
    expect(String(webPage.description)).not.toMatch(/8 weeks/i);
    expect(String(product.description)).not.toMatch(/8 weeks/i);
    expect(faq.mainEntity ?? []).toHaveLength(0);
    expect(serialized).not.toMatch(/KEY INGREDIENTS|\+5\. 9|\+9\. 9|\+14\. 5/);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "FAQPage.mainEntity" && String(repair.issue).includes("section heading"))).toBe(true);
  });

  it("repairs WebPage description sentences that list usage with ingredient technology coverage", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "에스트라 아토베리어365 캡슐 토너 상품 페이지는 건조 피부 또는 민감 피부 고객이 토너를 선택할 때 필요한 상품 정보를 안내합니다. 고객은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 세라마이드·콜레스테롤·지방산, 하이드로겔 플로팅 포뮬러, 사용법을 확인하고 사용 직후 수분량 1.3배 증가 결과를 함께 비교할 수 있습니다."
            },
            {
              "@type": "Product",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "에스트라 아토베리어365 캡슐 토너",
          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
          quickFacts: "핵심 정보",
          benefits: "보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "손바닥에 적당량을 덜어냅니다",
          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const description = String(webPage.description);

    expect(description).not.toContain("하이드로겔 플로팅 포뮬러, 사용법을 확인");
    expect(description).toContain("성분/기술 정보를 확인");
    expect(description).not.toContain("사용법은 HowTo 영역에서 별도로 확인할 수 있습니다");
    expect(description).not.toMatch(/사용법|사용 방법/);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
  });

  it("repairs WebPage description sentences that mix concrete HowTo steps with FAQ topics", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "에스트라 아토베리어365 캡슐 토너 상품 페이지는 민감 피부 또는 건조 피부가 피부 장벽 케어와 속보습을 비교할 때 참고할 수 있는 세라마이드 캡슐 수분 토너 정보를 다룹니다. 손바닥에 적당량을 덜어 얼굴 전체에 펴 바른 뒤 가볍게 두드려 흡수시키는 방법과 캡슐이 워터에 떠 있는 이유, 크림 캡슐 동일 여부를 FAQ와 HowTo에서 확인할 수 있습니다. 외부자극인 Tape Stripping에 의한 장벽 손상 회복, 세정에 의한 장벽 손상 즉시 회복, 피부결과 투명도 개선 결과, 구매 정보와 FAQ가 함께 제공됩니다."
            },
            {
              "@type": "Product",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "에스트라 아토베리어365 캡슐 토너",
          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
          quickFacts: "핵심 정보",
          benefits: "보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "손바닥에 적당량을 덜어냅니다",
          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const description = String(webPage.description);

    expect(description).not.toMatch(/민감 피부 또는 건조 피부가[^.]*비교할 때/);
    expect(description).toMatch(/민감 피부 또는 건조 피부 고객에게/);
    expect(description).toContain("피부 장벽 케어와 속보습에 효과적인 세라마이드 캡슐 수분 토너 상품을 추천합니다");
	    expect(description).not.toMatch(/손바닥에 적당량|얼굴 전체에 펴 바른|FAQ와 HowTo/);
	    expect(description).not.toMatch(/FAQ에서는|FAQ와 HowTo|구매 정보|FAQ가 함께 제공|캡슐이 워터에 떠 있는 이유|크림 캡슐 동일 여부/);
	    expect(description).toContain("피부결과 투명도 개선 결과입니다");
	    expect(description).not.toMatch(/제시합니다|제시됩니다|나타났습니다/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
		  });

		  it("splits Korean WebPage description sentences that merge ingredient lists with numeric evidence", () => {
		    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
		      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "WebPage",
		              name: "에스트라 아토베리어365 캡슐 토너",
		              description: "에스트라 아토베리어365 캡슐 토너 상품 페이지에서는 건조 피부 또는 민감 피부 고객에게 장벽 보습, 수분 진정, 피부결 정돈을 돕는 고보습 장벽 캡슐 토너를 추천합니다. 고밀도 세라마이드 캡슐, PHA 워터, 하이드로겔 플로팅 포뮬러, 세라마이드/콜레스테롤/지방산 구성과 18시간 장벽 세라마이드 잔존 ex vivo 테스트 결과 190%, 사용 7일 후 피부결 7.9% 및 투명도 6.0% 개선 수치가 선택의 핵심 근거로를 제공합니다."
		            },
		            {
		              "@type": "Product",
		              name: "에스트라 아토베리어365 캡슐 토너",
		              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
		            }
		          ]
		        },
		        scriptTag: ""
		      },
		      content: {
		        sections: {
		          productName: "에스트라 아토베리어365 캡슐 토너",
		          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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
		    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
		    const description = String(webPage.description);

		    expect(description).not.toMatch(/근거로를|선택의 핵심 근거/);
      expect(description).toContain("핵심 성분/기술은 고밀도 세라마이드 캡슐, PHA 워터, 하이드로겔 플로팅 포뮬러, 세라마이드·콜레스테롤·지방산 구성이며, 장벽 보습, 수분 진정, 피부결 정돈을 뒷받침합니다");
      expect(description).not.toMatch(/핵심 성분\/기술은 [^.]+ 구성입니다\./);
			    expect(description).toContain("ex vivo 테스트 기준, 18시간 장벽 세라마이드 잔존율은 190%이고, 사용 7일 후 피부결은 7.9%, 투명도는 6.0% 개선되었습니다");
			    expect(description).not.toMatch(/수치가 제시됩니다|결과가 제시됩니다|나타났습니다/);
			    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
			  });

			  it("repairs Korean WebPage description patent technology and FAQ-topic navigation sentences", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
			      locale: "ko-KR",
			      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
			      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			      schemaMarkup: {
			        jsonLd: {
			          "@context": "https://schema.org",
			          "@graph": [
			            {
			              "@type": "WebPage",
			              name: "에스트라 아토베리어365 캡슐 토너",
			              description: "에스트라 아토베리어365 캡슐 토너 상품 페이지에서는 건조 민감 피부 고객에게 피부 장벽 케어와 100시간 보습 지속을 내세우는 고보습 세라마이드 캡슐 토너를 소개합니다. 핵심 기술은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 하이드로겔 플로팅 포뮬러, 하이드로겔 서스펜션이며 특허 출원 번호는 KR102023-0133775입니다. Tape Stripping 테스트에서 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복된 것으로 제시됩니다. 캡슐이 워터 안에 떠 있는 이유와 아토베리어365 크림 캡슐 관련 질문도 함께 다룹니다."
			            },
			            {
			              "@type": "Product",
			              name: "에스트라 아토베리어365 캡슐 토너",
			              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
			            }
			          ]
			        },
			        scriptTag: ""
			      },
			      content: {
			        sections: {
			          productName: "에스트라 아토베리어365 캡슐 토너",
			          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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
			    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
			    const description = String(webPage.description);

			    expect(description).not.toMatch(/특허 출원 번호|KR102023-0133775|질문도 함께 다룹니다|크림 캡슐 관련 질문/);
			    expect(description).toContain("피부 장벽 케어와 100시간 보습 지속을 뒷받침하는 핵심 성분/기술은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 하이드로겔 플로팅 포뮬러, 하이드로겔 서스펜션입니다");
			    expect(description).toContain("Tape Stripping 테스트 기준, 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복되었습니다");
			    expect(description).not.toMatch(/사용 직후는|사용 7일 후는|제시됩니다|나타났습니다/);
			    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
			  });

			  it("repairs Korean FAQ comparison answers that mix patent identifiers with formula technology", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
			      locale: "ko-KR",
			      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
			      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			      schemaMarkup: {
			        jsonLd: {
			          "@context": "https://schema.org",
			          "@graph": [
			            {
			              "@type": "Product",
			              name: "에스트라 아토베리어365 캡슐 토너",
			              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
			            },
			            {
			              "@type": "FAQPage",
			              mainEntity: [
			                {
			                  "@type": "Question",
			                  name: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
			                  acceptedAnswer: {
			                    "@type": "Answer",
			                    text: "에스트라 아토베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐 특허 출원 포뮬러로 설명됩니다. 아토베리어365 크림 캡슐과 동일하다고 단정하기는 어렵고, 이 토너는 물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄운 하이드로겔 플로팅 포뮬러 기술과 특허출원번호 KR102023-0133775가 제시됩니다."
			                  }
			                }
			              ]
			            }
			          ]
			        },
			        scriptTag: ""
			      },
			      content: {
			        sections: {
			          productName: "에스트라 아토베리어365 캡슐 토너",
			          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			          quickFacts: "핵심 정보",
			          benefits: "보습",
			          ingredients: "고밀도 세라마이드 캡슐",
			          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
			          faq: "Q. 아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?\nA. 에스트라 아토베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐 특허 출원 포뮬러로 설명됩니다."
			        },
			        html: "<div class=\"geo-content-accordion\"></div>"
			      }
			    });

			    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
			    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
			    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

			    expect(answer).toBe("공개된 상품 정보만으로는 아토베리어365 크림 캡슐과 동일하다고 단정하기 어렵습니다. 에스트라 아토베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐로 설명됩니다.");
				    expect(answer).not.toMatch(/특허출원번호|KR102023-0133775|포뮬러 기술|하이드로겔 플로팅 포뮬러 기술/);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
				  });

					  it("repairs Korean suitability FAQ metric endings into direct effect wording", () => {
					    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
				      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "에스트라 아토베리어365 캡슐 토너",
				              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "에스트라 아토베리어365 캡슐 토너는 민감·건조 피부와 피부 장벽 약화가 고민인 고객에게 추천할 수 있는 고보습 캡슐 토너입니다. 세라마이드 캡슐로 속보습부터 피부장벽까지 채워주는 제품으로 소개되며, 피부 장벽 케어, 고보습 케어, 진정 케어와 사용 직후 수분량 1.3배 증가 결과가 제시됩니다."
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "에스트라 아토베리어365 캡슐 토너",
				          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "보습",
				          ingredients: "고밀도 세라마이드 캡슐",
				          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
				          faq: "Q. 에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?\nA. 민감·건조 피부와 피부 장벽 약화가 고민인 고객에게 추천할 수 있습니다."
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

				    expect(answer).toContain("사용 직후 수분량 1.3배 증가 효과가 있습니다");
					    expect(answer).not.toMatch(/결과가 제시됩니다/);
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
					  });

						  it("rewrites positive Korean review-intent FAQ and removes negative raw review text", () => {
					    const repaired = validateAndRepairPdpGeoArtifacts({
					      locale: "ko-KR",
					      fallbackProductName: "에스트라 아토베리어365 클렌징폼",
					      fallbackDescription: "에스트라 아토베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
					      schemaMarkup: {
					        jsonLd: {
					          "@context": "https://schema.org",
					          "@graph": [
					            {
					              "@type": "Product",
					              name: "에스트라 아토베리어365 클렌징폼",
					              description: "에스트라 아토베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다."
					            },
					            {
					              "@type": "FAQPage",
					              mainEntity: [
					                {
					                  "@type": "Question",
					                  name: "뽀득거리지도 미끌거리지도 않아요 약산성과 약알칼리성의 중간인 느낌?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "에스트라 아토베리어365 클렌징폼은 고객 리뷰에서 뽀득하거나 미끌거리는 느낌보다 크리미하고 세안 후 촉촉한 데일리 폼클렌저로 언급됩니다. 약산성 아미노산 유래 세정 성분과 Barrier Protective Formula가 장벽 손상 방어와 클렌징 중 장벽보호 포인트로 표시됩니다."
					                  }
					                },
					                {
					                  "@type": "Question",
					                  name: "5 5 sunh6712 2026-06-08 무난하게 데일리로 사용하기 좋아요 성분이 착해서 그런지 민감성, 건성인 피부에도 트러블 올라오지 않고 좋아요 조금 아쉬운 부분이 있다면 세안할때 향이 좀 약품냄새? ?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "에스트라 아토베리어365 클렌징폼은 고객 리뷰에서 민감성·건성 피부에도 데일리로 쓰기 무난하고 세안 후 촉촉하다는 반응이 있습니다. 다만 일부 리뷰에는 세안할 때 약품 냄새처럼 느껴졌다는 아쉬움도 함께 언급됩니다."
					                  }
					                },
					                {
					                  "@type": "Question",
					                  name: "에스트라 아토베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "에스트라 아토베리어365 클렌징폼은 건조 피부 또는 민감 피부 고객에게 추천할 수 있는 장벽보호 폼 클렌저입니다. Barrier Protective Formula와 약산성 아미노산 유래 세정 성분이 클렌징 중 장벽보호를 뒷받침합니다."
					                  }
					                }
					              ]
					            }
					          ]
					        },
					        scriptTag: ""
					      },
					      content: {
					        sections: {
					          productName: "에스트라 아토베리어365 클렌징폼",
					          description: "에스트라 아토베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
					          quickFacts: "핵심 정보",
					          benefits: "장벽보호",
					          ingredients: "Barrier Protective Formula, 약산성 아미노산 유래 세정 성분",
					          howToUse: "적당량을 덜어 거품을 낸 뒤 얼굴을 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.",
					          faq: "Q. 뽀득거리지도 미끌거리지도 않아요 약산성과 약알칼리성의 중간인 느낌?\nA. 에스트라 아토베리어365 클렌징폼은 고객 리뷰에서 크리미하고 세안 후 촉촉한 데일리 폼클렌저로 언급됩니다.\n\nQ. 5 5 sunh6712 2026-06-08 무난하게 데일리로 사용하기 좋아요 성분이 착해서 그런지 민감성, 건성인 피부에도 트러블 올라오지 않고 좋아요 조금 아쉬운 부분이 있다면 세안할때 향이 좀 약품냄새? ?\nA. 에스트라 아토베리어365 클렌징폼은 고객 리뷰에서 민감성·건성 피부에도 데일리로 쓰기 무난하고 세안 후 촉촉하다는 반응이 있습니다.\n\nQ. 에스트라 아토베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?\nA. 에스트라 아토베리어365 클렌징폼은 건조 피부 또는 민감 피부 고객에게 추천할 수 있는 장벽보호 폼 클렌저입니다."
					        },
					        html: "<div class=\"geo-content-accordion\"></div>"
					      }
					    });

					    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
					    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
					    const questions = faq.mainEntity.map((item: any) => String(item.name));
					    const answers = faq.mainEntity.map((item: any) => String(item.acceptedAnswer.text));
					    const serializedFaq = JSON.stringify(faq);

					    expect(questions).toEqual([
					      "고객 리뷰는 에스트라 아토베리어365 클렌징폼의 어떤 사용감을 강조하나요?",
					      "에스트라 아토베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?"
					    ]);
					    expect(serializedFaq).not.toMatch(/sunh6712|2026-06-08|뽀득거리지도 미끌거리지도 않아요|무난하게 데일리로 사용하기 좋아요|약품냄새/);
					    expect(answers[0]).toMatch(/균형 잡힌 세정감|크리미한 사용감|세안 후 촉촉함/);
					    expect(answers[0]).not.toMatch(/Barrier Protective Formula|약산성 아미노산|장벽 손상 방어/);
					    expect(answers[1]).toContain("장벽보호 폼 클렌저");
					    expect(serializedFaq).not.toMatch(/약품 냄새|향에 대한 체감|아쉬운/);
					    expect(repaired.content.sections.faq).not.toMatch(/sunh6712|2026-06-08|뽀득거리지도 미끌거리지도 않아요|무난하게 데일리로 사용하기 좋아요|약품냄새|약품 냄새|아쉬운/);
					    expect(repaired.content.sections.faq).toContain("고객 리뷰는 에스트라 아토베리어365 클렌징폼의 어떤 사용감을 강조하나요?");
					    expect(repaired.content.sections.faq).toContain("에스트라 아토베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?");
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity")).toBe(true);
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.faq")).toBe(true);
					  });

					  it("repairs Korean usage FAQ answers that leak raw review expectation text", () => {
				    const badAnswer = "에스트라 아토베리어365 젠틀 포밍클렌저는 세럼, 앰플, 에센스 등 스킨케어 루틴 단계와 함께 사용할 수 있습니다. 사용법은 아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요입니다. 판테놀, 세라마이드, DermaON® 기술 성분/기술 맥락과 함께 루틴 선택 기준을 제공합니다.";
				    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "에스트라 아토베리어365 젠틀 포밍클렌저",
				      fallbackDescription: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "에스트라 아토베리어365 젠틀 포밍클렌저",
				              description: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 루틴에서 함께 쓰기 좋나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: badAnswer
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "에스트라 아토베리어365 젠틀 포밍클렌저",
				          description: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "장벽보호",
				          ingredients: "판테놀, 세라마이드, DermaON® 기술",
				          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 미온수로 깨끗이 헹굽니다.",
				          faq: `Q. 에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 루틴에서 함께 쓰기 좋나요?\nA. ${badAnswer}`
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

				    expect(answer).toBe("에스트라 아토베리어365 젠틀 포밍클렌저는 세럼, 앰플, 에센스 등 스킨케어 루틴 단계와 함께 사용할 수 있습니다.");
				    expect(JSON.stringify(repaired.schemaMarkup.jsonLd)).not.toMatch(/아직 본격적으로|평이 좋아서|기대가 많이|성분\/기술\s*맥락|루틴 선택 기준/);
				    expect(repaired.content.sections.faq).not.toMatch(/아직 본격적으로|평이 좋아서|기대가 많이|성분\/기술\s*맥락|루틴 선택 기준/);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.faq")).toBe(true);
				  });

				  it("deduplicates overlapping Korean FAQ ingredient-benefit and benefit-overview questions", () => {
				    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "에스트라 아토베리어365 젠틀 포밍클렌저",
				      fallbackDescription: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "에스트라 아토베리어365 젠틀 포밍클렌저",
				              description: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부의 저자극 세안, 피부 장벽 케어, 보습력 개선, 피부결 사이 노폐물 세정에 적합한 포밍 클렌저입니다."
				                  }
				                },
				                {
				                  "@type": "Question",
				                  name: "AESTURA 에스트라 아토베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "AESTURA 에스트라 아토베리어365 젠틀 포밍클렌저의 주요 성분/기술은 Barrier Protective Formula, 판테놀, 베타인, 더마온입니다. 판테놀은 피부 장벽 강화, 피부 진정 개선, 피부 보습 개선에 연결되고, 더마온은 피부장벽 구성 강화와 피부 보습력 개선에 연결됩니다."
				                  }
				                },
				                {
				                  "@type": "Question",
				                  name: "에스트라 아토베리어365 젠틀 포밍클렌저는 어떻게 사용하나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다."
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "에스트라 아토베리어365 젠틀 포밍클렌저",
				          description: "에스트라 아토베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "저자극 세안",
				          ingredients: "Barrier Protective Formula, 판테놀, 베타인, 더마온",
				          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.",
				          faq: "Q. 에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?\nA. 건조 피부 또는 민감 피부의 저자극 세안에 적합합니다.\n\nQ. AESTURA 에스트라 아토베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?\nA. 주요 성분/기술은 Barrier Protective Formula, 판테놀, 베타인, 더마온입니다."
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const questions = faq.mainEntity.map((item: Record<string, any>) => String(item.name));

				    expect(questions).toContain("AESTURA 에스트라 아토베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?");
				    expect(questions).not.toContain("에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?");
				    expect(questions).toContain("에스트라 아토베리어365 젠틀 포밍클렌저는 어떻게 사용하나요?");
				    expect(repaired.content.sections.faq).toContain("AESTURA 에스트라 아토베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?");
				    expect(repaired.content.sections.faq).not.toContain("에스트라 아토베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?");
				    expect(repaired.validationRepairs.some((repair) =>
				      repair.source === "field-contract-validator"
				      && repair.field === "FAQPage.mainEntity"
				      && String(repair.issue).includes("overlapping ingredient-benefit")
				    )).toBe(true);
				    expect(repaired.validationRepairs.some((repair) =>
				      repair.source === "field-contract-validator"
				      && repair.field === "content.sections.faq"
				      && String(repair.issue).includes("overlapping ingredient-benefit")
				    )).toBe(true);
				  });

				  it("repairs Korean HowTo steps with leading particles and duplicate surface variants", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
	      locale: "ko-KR",
	      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
	      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	      schemaMarkup: {
	        jsonLd: {
	          "@context": "https://schema.org",
	          "@graph": [
	            {
	              "@type": "Product",
	              name: "에스트라 아토베리어365 캡슐 토너",
	              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
	            },
	            {
	              "@type": "HowTo",
	              name: "에스트라 아토베리어365 캡슐 토너 사용법",
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
	          productName: "에스트라 아토베리어365 캡슐 토너",
	          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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
		      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
		      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "에스트라 아토베리어365 캡슐 토너",
		              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "에스트라 아토베리어365 캡슐 토너 사용 방법",
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
		          productName: "에스트라 아토베리어365 캡슐 토너",
		          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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

			  it("splits and deduplicates Korean cleanser HowTo compound steps", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "에스트라 아토베리어365 클렌징폼",
		      fallbackDescription: "에스트라 아토베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "에스트라 아토베리어365 클렌징폼",
		              description: "에스트라 아토베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "에스트라 아토베리어365 클렌징폼 사용법",
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
		          productName: "에스트라 아토베리어365 클렌징폼",
		          description: "에스트라 아토베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다.",
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

		    expect(steps.map((step) => step.position)).toEqual([1, 2, 3]);
		    expect(steps.map((step) => step.name)).toEqual(["1단계", "2단계", "3단계"]);
		    expect(steps.map((step) => step.text)).toEqual([
		      "적당량을 덜어 물과 함께 거품을 냅니다",
		      "얼굴에 부드럽게 마사지합니다",
		      "미온수로 깨끗이 헹굽니다"
		    ]);
		    expect(stepText).not.toMatch(/방식이다|마사지합니다 2|거품을 낸다|마사지한다/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text" && /combined multiple/.test(repair.issue))).toBe(true);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text" && /duplicated/.test(repair.issue))).toBe(true);
		  });

		  it("removes Korean customer review text from HowTo steps", () => {
		    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "에스트라 아토베리어365 젠틀 포밍클렌저",
		      fallbackDescription: "에스트라 아토베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "에스트라 아토베리어365 젠틀 포밍클렌저",
		              description: "에스트라 아토베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "에스트라 아토베리어365 젠틀 포밍클렌저 사용 방법",
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
		          productName: "에스트라 아토베리어365 젠틀 포밍클렌저",
		          description: "에스트라 아토베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다.",
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
		    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
		    const steps = howTo.step as Array<Record<string, any>>;
		    const stepText = JSON.stringify(steps);

		    expect(steps.map((step) => step.position)).toEqual([1, 2, 3]);
		    expect(stepText).toContain("적당량을 덜어 물과 함께 거품을 냅니다");
		    expect(stepText).toContain("얼굴에 부드럽게 마사지합니다");
		    expect(stepText).toContain("미온수로 깨끗이 헹굽니다");
		    expect(stepText).not.toMatch(/아직 본격적으로|초등학생 딸|sulyeon04130|wlsk7622|배송 빠르고|워낙 평이 좋아서|필요해서 구매/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text")).toBe(true);
		  });

		  it("repairs repeated Korean HowTo variants and raw certification or positiveNote fragments", () => {
	    const repaired = validateAndRepairPdpGeoArtifacts({
	      locale: "ko-KR",
	      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
	      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	      schemaMarkup: {
	        jsonLd: {
	          "@context": "https://schema.org",
	          "@graph": [
	            {
	              "@type": "Product",
	              name: "에스트라 아토베리어365 캡슐 토너",
	              description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	              additionalProperty: [
	                {
	                  "@type": "PropertyValue",
	                  name: "Functional certification",
	                  value: "민감 피부도 사용할 수 있는 순한 저자극 토너, 민감성 피부 사용 적합 테스트 완료 건조 민감 피부를 고려한 스킨케어 효와 피부 장벽 강화 피부 보습 피부 진정"
	                }
	              ],
	              positiveNotes: {
	                "@type": "ItemList",
	                itemListElement: [
	                  {
	                    "@type": "ListItem",
	                    position: 1,
	                    name: "피부 장벽"
	                  },
	                  {
	                    "@type": "ListItem",
	                    position: 2,
	                    name: "DermaON® 기술, 고밀도 세라마이드 캡슐, 성분으로 세라마이드 캡슐 기반 피부 장벽, 수분감, 보습 케어 케어"
	                  }
	                ]
	              }
	            },
	            {
	              "@type": "HowTo",
	              name: "에스트라 아토베리어365 캡슐 토너 사용 방법",
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
	          productName: "에스트라 아토베리어365 캡슐 토너",
	          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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
	    const positiveNotes = JSON.stringify(product.positiveNotes);
	    const steps = howTo.step as Array<Record<string, any>>;

	    expect(steps).toHaveLength(2);
	    expect(JSON.stringify(steps)).toContain("손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바릅니다");
	    expect(JSON.stringify(steps)).not.toMatch(/펴 발라줍니다|펴 바른다|펴 바르는 것이다/);
	    expect(certification.value).toBe("민감성 피부 사용 적합 테스트 완료");
	    expect(positiveNotes).toContain("피부 장벽");
	    expect(positiveNotes).not.toMatch(/성분으로|케어 케어|DermaON® 기술, 고밀도/);
	  });

	  it("removes concrete usage directions from Product description while keeping metric evidence", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "에스트라 아토베리어365 캡슐 토너는 PHA 워터에 띄워진 고밀도 세라마이드 캡슐을 담은 장벽 보습 캡슐 토너입니다. 외부자극인 Tape Stripping에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복된 결과가 제시되며, 사용 시 화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다."
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
          productName: "에스트라 아토베리어365 캡슐 토너",
          description: "에스트라 아토베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
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
    expect(JSON.stringify(howTo.step)).toContain("화장솜에 적당량");
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "Product.description")).toBe(true);
  });

  it("keeps undisclosed sample scope next to Korean reported metric claims", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 캡슐 토너",
          brand: "AESTURA",
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
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
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
    expect(reportedDetails.value).toContain("시험 대상/표본 수");
    expect(reportedDetails.value).toMatch(/확인되지|미공개/);
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
    const howToStepText = JSON.stringify(howTo.step);

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

  it("repairs merged FAQ section markers before rebuilding public HTML", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Gentle Cleansing Foam",
      fallbackDescription: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "Gentle Cleansing Foam",
              description: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Gentle Cleansing Foam",
          description: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin.",
          quickFacts: "Key benefit: hydration",
          benefits: "- Hydration",
          ingredients: "- Hydro-cleansing formula",
          howToUse: "1. Lather with water and massage onto damp skin.",
          faq: "Q. What does Gentle Cleansing Foam do?\nA. It supports clean, hydrated-feeling skin. Q. How should Gentle Cleansing Foam be used?\nA. 1based on the product detail, lather with water and rinse."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    expect(repaired.content.sections.faq).toContain("\n\nQ. How should Gentle Cleansing Foam be used?");
    expect(repaired.content.sections.faq).toContain("\nA. 1 based on the product detail");
    expect(repaired.content.html).toContain("How should Gentle Cleansing Foam be used?");
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.faq")).toBe(true);
  });

  it("repairs final schema descriptions when Product and WebPage roles collapse", () => {
    const productFallback = "Hydra Balance Essence is an essence for dry skin with Hyaluronic Acid and hydration support.";
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Hydra Balance Essence",
      fallbackDescription: productFallback,
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "Hydra Balance Essence product page",
              description: `This Hydra Balance Essence product page introduces ${productFallback}`
            },
            {
              "@type": "Product",
              name: "Hydra Balance Essence",
              description: "This Hydra Balance Essence product page summarizes hydration and Hyaluronic Acid for dry skin customers."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Hydra Balance Essence",
          description: productFallback,
          quickFacts: "Key ingredient: Hyaluronic Acid",
          benefits: "Hydration support",
          ingredients: "Hyaluronic Acid",
          howToUse: "Apply morning and night after cleansing.",
          faq: "Q. Who is Hydra Balance Essence for?\nA. It is for dry skin customers comparing hydration support."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect(product.description).toBe(productFallback);
    expect(String(product.description)).not.toMatch(/product\s+page|PDP|page\s+(?:covers|introduces|summarizes)/i);
    expect(webPage.description).not.toBe(product.description);
    expect(String(webPage.description)).toContain("Hydra Balance Essence product page");
    expect(repaired.validationRepairs.some((repair) =>
      repair.field === "Product.description"
      && String(repair.issue).includes("product page or page coverage")
    )).toBe(true);
    expect(repaired.validationRepairs.some((repair) =>
      repair.field === "WebPage.description"
      && String(repair.issue).includes("repeated Product.description")
    )).toBe(true);
  });
});

describe("generatePdpGeo FAQ citation coverage", () => {
  it("keeps at least four citable FAQ questions when benefit/ingredient/metric/review evidence exists", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 캡슐 토너",
          brand: "AESTURA",
          category: "토너",
          description: "건조하거나 민감한 피부의 세안 후 첫 단계 보습 루틴을 위한 장벽 보습 캡슐 토너입니다.",
          benefits: ["피부 장벽", "수분감", "피부결"],
          ingredients: ["PHA 워터", "고밀도 세라마이드 캡슐", "콜레스테롤", "지방산"],
          sourceTexts: [
            "Tape Stripping 테스트에서 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복되었습니다.",
            "하이드로겔 플로팅 포뮬러는 물에 녹지 않는 세라마이드를 캡슐 형태로 PHA 워터에 띄우는 특허 출원 포뮬러입니다."
          ],
          reviews: {
            rating: 4.7,
            reviewCount: 1200,
            keywords: ["장벽 보습", "피부결", "수분감"]
          },
          faq: [
            {
              question: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
              answer: "아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 하이드로겔 플로팅 포뮬러 제품입니다."
            },
            {
              question: "캡슐이 워터 안에 떠 있는 것이 왜 중요한가요?",
              answer: "세라마이드가 물에 녹지 않는 성분이기 때문에 캡슐 형태로 워터에 띄워 사용할 때마다 장벽 보습을 제공하도록 설계되었습니다."
            }
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1149"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const answers = (faqPage.mainEntity as Array<Record<string, any>>).map((item) => String(item.acceptedAnswer?.text ?? ""));

    expect(faqPage.mainEntity.length).toBeGreaterThanOrEqual(4);
    for (const answer of answers) {
      expect(answer).not.toMatch(/확인하기 어렵|확인이 어렵|알 수 없습니다/);
    }
  });
});
