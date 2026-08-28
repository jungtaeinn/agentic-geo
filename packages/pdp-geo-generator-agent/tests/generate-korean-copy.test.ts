import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

/**
 * 한국어 공개 문구 — 설명·FAQ 문안이 근거에 묶인 채 고객 언어로 나오는지.
 *
 * generate-pdp-geo.test.ts에서 주제별로 분리했다(어서션은 그대로).
 */

describe("generatePdpGeo", () => {
  it("writes Korean FAQ answers as direct AI-citation-friendly customer answers", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 바디로션",
          description: "건조 피부와 민감 피부를 위한 고보습 바디로션으로, 건조로 민감해진 피부장벽 강화에 도움을 줍니다.",
          category: "바디로션",
          benefits: ["보습 케어", "촘촘한 피부장벽 고밀도 케어"],
          effects: ["하루종일 촉촉함을 유지하는 고보습 케어"],
          ingredients: ["초미세세라마이드™", "세라마이드", "글루코사민"],
          usage: ["부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요."],
          reviews: {
            rating: 5,
            reviewCount: 1,
            keywords: ["촉촉한 사용감", "흡수감"],
            items: [{ body: "촉촉하고 흡수가 잘돼 만족합니다.", rating: 5 }]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/web/product/view.do?prdSeq=1086"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const benefitFaq = faq.mainEntity[0] as Record<string, any>;
    const ingredientFaq = faq.mainEntity[1] as Record<string, any>;
    const benefitAnswer = String(benefitFaq.acceptedAnswer.text);
    const ingredientAnswer = String(ingredientFaq.acceptedAnswer.text);

    expect(product.description).toMatch(/수분감|보습/);
    expect(product.description).toContain("피부 장벽");
    expect(product.description).not.toMatch(/설명됩니다|상품 정보에는|제품 자료에서는|확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다/);
    expect(benefitAnswer).toMatch(/건조하고 민감한 피부 고객을 위한/u);
    expect(String(benefitFaq.name)).toMatch(/고객|추천|적합/u);
    expect(benefitAnswer).toMatch(/예시더마 배리어케어365 바디로션은[^.]*수분[^.]*피부 장벽[^.]*돕습니다/u);
    expect(benefitAnswer).toContain("피부 장벽");
    expect(benefitAnswer).toContain("바디로션입니다");
    expect(benefitAnswer).toMatch(/고객 리뷰에서는[^.]*촉촉한 사용감[^.]*흡수감[^.]*언급/u);
    expect(ingredientAnswer).toMatch(/주요 성분·기술로 구성한/u);
    expect(String(ingredientFaq.name)).toMatch(/구성\s*성분.*효능[·・]?효과/u);
    expect(ingredientAnswer).toMatch(/완제품은[^.]*수분[^.]*피부 장벽[^.]*돕습니다/u);
    expect(ingredientAnswer).not.toMatch(/관계는 명시되어 있지|특정 성분이[^.]*단독/u);
    expect(`${benefitAnswer} ${ingredientAnswer}`).not.toMatch(/상품 정보에는|제품 자료에서는|제시됩니다|설명됩니다|정리됩니다/);
    expect(result.content.sections.faq).toContain(benefitAnswer);
    expect(result.content.sections.faq).toContain(ingredientAnswer);
    expect(result.diagnostics.validationWarnings).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/mixed customer-review language into a product-detail answer/u)
    ]));
  });
  it("drops raw extracted review fragments instead of publishing them as product FAQ", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "배리어케어365 크림",
          description: "건조하고 민감한 피부를 위한 피부 장벽 보습 크림입니다.",
          category: "크림",
          benefits: ["피부 장벽", "수분감"],
          ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
          faq: [{
            question: "좀 넉넉하게 바르는데 아침엔 선크림부터 좀 밀리는?",
            answer: "듯한 느낌을 받아서 이건 밤에만 쓰고 아침엔 수딩크림을 바르고 있어요."
          }],
          reviews: {
            keywords: ["촉촉한 사용감", "흡수감"],
            items: [{ body: "촉촉하고 흡수가 잘돼 만족합니다.", rating: 5 }]
          }
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify(faq.mainEntity);
    expect(String(faq.mainEntity[0].name)).toMatch(/고객|추천|적합/u);
    expect(String(faq.mainEntity[1].name)).toMatch(/구성 성분.*효능[·・]?효과/u);
    expect(serialized).not.toMatch(/선크림부터 좀 밀리는|듯한 느낌을 받아서|밤에만 쓰고/u);
  });
  it("separates Korean target customer, brand science, and actionable usage through evidence reasoning", async () => {
    const technologyEvidence = "물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄운 하이드로겔 플로팅 포뮬러 기술이 적용되어, 사용할 때마다 필요한 만큼 도출되어 피부에 세라마이드 장벽 보습을 제공한다고 설명된다.";

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 캡슐 토너",
          description: "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너",
          brand: "EXAMPLEDERMA",
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
            "BarrierCapsule® 기술은 세라마이드, 콜레스테롤, 지방산을 포함한 독자적인 2-STEP 수분장벽 케어 기술로 소개된다."
          ],
          usage: [
            "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드",
            "캡슐. 피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드",
            "예시더마 배리어케어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 워터 서스펜션 플로팅 포뮬러 기술을 사용한다",
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
        url: "https://example.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    }, {
      customCopyRefiner: {
        refineCopy: () => ({
          schemaDescriptions: {
            webPage: "예시더마 배리어케어365 캡슐 토너 상품 페이지는 건조하고 민감한 피부 고객이 세안 후 첫 단계 장벽 보습 토너를 평가할 수 있도록 PHA 워터, 고밀도 세라마이드 캡슐, 특허 출원 워터 서스펜션 플로팅 포뮬러를 핵심 성분/기술로 설명합니다. 손바닥에 적당량을 덜어 얼굴 전체에 펴 바른 뒤 가볍게 두드려 흡수시키는 방법과 캡슐이 워터에 떠 있는 이유, 크림 캡슐 동일 여부를 FAQ와 HowTo에서 확인할 수 있습니다.",
            product: "건조하거나 민감한 피부 고객을 위한 예시더마 배리어케어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 워터 서스펜션 플로팅 포뮬러의 장벽 보습 캡슐 토너입니다."
          },
          schemaProperties: {
            "Target customer": "민감하고 건조한 피부에서 세안 후 첫 단계 속보습, 피부 장벽 케어, 피부결 정돈을 원하는 고객",
            "Brand science": "PHA 워터에 띄워진 고밀도 세라마이드 캡슐과 하이드로겔 플로팅 포뮬러를 통해 물에 녹지 않는 세라마이드를 캡슐 형태로 담아 세라마이드 장벽 보습을 제공하도록 설계되었습니다.",
            Usage: "손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바른 뒤 가볍게 두드려 흡수시킵니다."
          },
          contentSections: {
            description: "건조하거나 민감한 피부 고객을 위한 예시더마 배리어케어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 워터 서스펜션 플로팅 포뮬러의 장벽 보습 캡슐 토너입니다."
          }
        })
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const properties = Object.fromEntries((product.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));
    const howToText = JSON.stringify(howTo?.step ?? properties.Usage ?? result.content.sections.howToUse);

    expect(String(webPage.description)).toContain("예시더마 배리어케어365 캡슐 토너 상품 페이지는 EXAMPLEDERMA가 선보이는");
    expect(String(webPage.description)).toMatch(/예시더마 배리어케어365 캡슐 토너는[^.]*고객을 위한 제품/u);
    expect(String(webPage.description)).toMatch(/[^.]+(?:을|를) 주요 성분·기술로 포함하고[^.]+돕습니다/u);
    expect(String(webPage.description)).toContain("예시더마 배리어케어365 캡슐 토너는 30,000원에 판매되고 있습니다");
    expect(String(webPage.description)).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(String(webPage.description)).not.toMatch(/구매 판단에 필요한|가격·구매 정보/u);
    expect(String(webPage.description)).not.toMatch(/추천합니다|적합합니다|60\.5%|87\.3%/u);
    expect(String(webPage.description)).not.toContain("민감·건조 피부의 세안 후");
    expect(String(webPage.description)).not.toContain("고객이 세안 후 첫 단계에 쓰는");
    expect(String(webPage.description)).not.toContain("토너를 살펴보는 페이지입니다");
    expect(String(webPage.description)).not.toContain("하이드로겔 플로팅 포뮬러, 사용법을 확인");
    expect(String(webPage.description)).not.toMatch(/민감 피부 또는 건조 피부가[^.]*비교할 때/);
    expect(String(webPage.description)).not.toMatch(/핵심 성분\/(?:기술|포뮬러)|특허\s*출원[^.。！？]*포뮬러의|(?:성분|기술|포뮬러|캡슐|워터)[^.。！？]*(?:을|를)\s*중심으로\s*(?:제품|상품)(?:을|를)?\s*(?:소개|설명|제시)/);
    expect(String(webPage.description)).not.toContain("특허 출원 워터 서스펜션");
    expect(String(webPage.description)).not.toMatch(/손바닥에 적당량|얼굴 전체에 펴 바른|FAQ와 HowTo|FAQ에서는|FAQ와 사용법|HowTo/);
    expect(String(webPage.description)).not.toMatch(/탄력 저하|주름|노화|설명된다\s+사용법|설명됩니다\s+사용법/);
    expect(String(product.description)).not.toMatch(/손바닥에 적당량|화장솜에 적당량|피부결을 따라|가볍게 두드려|닦아냅니다/);
    expect(String(product.description)).not.toMatch(/특허\s*출원[^.。！？]*포뮬러의|핵심 성분\/(?:기술|포뮬러)|건조하거나 민감한 피부 고객을 위한[^.。！？]*포뮬러의/);
    expect(String(product.description)).not.toContain("특허 출원 워터 서스펜션");
    expect(String(product.description)).toMatch(/건조|민감/u);
    expect(String(product.description)).toMatch(/고밀도 세라마이드|피부 장벽|속보습/u);
    expect(result.content.sections.description).toBe(String(product.description));
    expect(String(properties["Target customer"])).toContain("민감하고 건조한 피부");
    expect(String(properties["Target customer"])).not.toMatch(/탄력 저하|주름|노화/);
    expect(String(properties["Brand science"])).toContain("하이드로겔 플로팅 포뮬러");
    expect(String(properties.Usage)).toContain("피부결을 따라");
    expect(String(properties.Usage)).not.toContain("물에 녹지 않는 세라마이드");
    expect(String(properties.Usage)).not.toMatch(/워터 서스펜션|포뮬러 기술을 사용/);
    expect(String(properties.Usage)).not.toMatch(/피부 장벽 유사 성분|바르는 순간|세라마이드 캡슐 세라마이드/);
    expect(String(properties["Reported details"])).toMatch(/60\.5%|87\.3%/u);
    expect(String(properties["Reported details"])).not.toMatch(/시험 대상\/표본 수|미공개/u);
    expect(howToText).toContain("손바닥에 적당량");
    expect(howToText).toContain("피부결을 따라");
    expect(howToText).not.toContain("물에 녹지 않는 세라마이드");
    expect(howToText).not.toMatch(/워터 서스펜션|포뮬러 기술을 사용|PHA 워터에 고밀도 세라마이드 캡슐/);
    expect(howToText).not.toMatch(/피부 장벽 유사 성분|바르는 순간|세라마이드 캡슐 세라마이드/);
  });
  it("keeps Korean cream mist descriptions and review queries grounded in the specific product type", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "배리어케어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 세라마이드 10,000ppm 보습 미스트입니다. 흔들 필요 없는 특수 에멀징 공법으로 수분 충전과 보습막 형성, 수분 장벽 케어를 돕습니다.",
          brand: "EXAMPLEDERMA",
          category: "크림",
          benefits: ["수분 충전", "보습막 형성", "수분 장벽 케어"],
          effects: ["건조할 때 수시 보습", "터치리스 착붙보습"],
          ingredients: ["세라마이드 10,000ppm", "피토스핑고신", "콜레스테롤", "흔들 필요 없는 특수 에멀징 공법"],
          usage: ["눈을 감고 얼굴에 고루 분사한 뒤 손으로 흡수시킵니다."],
          faq: [
            {
              question: "배리어케어 365 크림 미스트는 어떤 피부에 적합한가요?",
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
        url: "https://example.com/web/product/view.do?prdSeq=1027"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const description = String(webPage.description);
    const productDescription = String(product.description);
    const propertyText = JSON.stringify(product.additionalProperty);

    expect(product.category).toBe("크림 미스트");
    expect(result.content.sections.description).toBe(productDescription);
    expect(description).not.toBe(productDescription);
    const targetIndex = productDescription.indexOf("건조하고 민감한 피부");
    const identityIndex = productDescription.indexOf("크림 미스트입니다");
    const productNameIndex = productDescription.indexOf("배리어케어 365 크림 미스트");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(productNameIndex).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(identityIndex);
    expect(identityIndex).toBeLessThan(productDescription.indexOf("세라마이드 10,000ppm"));
    expect(productDescription.search(/피부 장벽 케어|수분감 케어|보습 케어/)).toBeGreaterThan(targetIndex);
    expect(productDescription.indexOf("세라마이드 10,000ppm")).toBeLessThan(productDescription.search(/피부 장벽 케어|수분감 케어|보습 케어/));
    expect(productDescription).toMatch(/건조할 때 수시 보습.*루틴|리뷰(?:\s*한\s*건)?에서는/);
    expect(productDescription).not.toMatch(/상품\s*페이지|제품\s*페이지|페이지(?:에서는|에는|는)|PDP|product\s+page/i);
    expect(productDescription).not.toMatch(/눈을 감고|얼굴에 고루 분사|손으로 흡수|FAQ|HowTo|비건|동물실험|동물성 원료|GLOWPICK|post-cleanse/);
    expect(description).toContain("배리어케어 365 크림 미스트 상품 페이지는 EXAMPLEDERMA가 선보이는");
    expect(description).toMatch(/배리어케어 365 크림 미스트는[^.]*건조하고 민감한 피부 고객을 위한 제품/u);
    expect(description).toMatch(/[^.]+(?:을|를) 주요 성분·기술로 포함하고[^.]+돕습니다/u);
    expect(description).toMatch(/고객 리뷰에서 고객들은/u);
    expect(description).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(description).not.toMatch(/45개 리뷰/u);
    expect(description).not.toMatch(/피부 내성 테스트|하이포알러제닉 테스트|사용 맥락은[^.]*보완/);
    expect(description).not.toMatch(/세라마이드[^.]*피토스핑고신[^.]*콜레스테롤과[^.]*공법은/);
    expect(description).not.toMatch(/상품 정보로\s*(?:주요\s*)?효능,\s*성분\/기술,\s*사용 루틴|HowTo|FAQ에서는|로 제시됩니다|확인됩니다|비건|동물실험|동물성 원료|GLOWPICK|post-cleanse/);
    expect(propertyText).toContain("콜레스테롤");
    expect(propertyText).toContain("특수 에멀징 공법");
    expect(propertyText).toMatch(/피부 내성 테스트|하이포알러제닉 테스트/);
    // Q&A units live only in FAQPage + diagnostics, never as flat properties.
    expect(propertyText).not.toMatch(/무엇인가요\?/);
    expect(propertyText).not.toMatch(/세라마이드,\s*Ceramide|Ceramide\s*성분\/기술/);
    const queryText = JSON.stringify(result.diagnostics.inferredSearchQueries ?? []);
    expect(queryText).toMatch(/건조하고 민감한 피부 고객에게[^?]*크림 미스트는 무엇인가요\?/);
    expect(queryText).not.toMatch(/고객에게[^?]*\s크림은 무엇인가요\?/);
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
          name: "예시럭셔리 보태니컬 리뉴얼 크림",
          description: "탄력 저하, 주름, 피부 밀도 감소 등 노화 징후를 케어하는 안티에이징 크림입니다. 민감 피부 사용 적합 테스트를 완료했습니다.",
          brand: "예시럭셔리",
          category: "크림",
          benefits: ["수분감", "피부결", "탄력", "피부 장벽"],
          effects: ["탄력 저하와 주름 등 노화 징후 케어", "피부 밀도와 피부결 케어"],
          ingredients: ["식물 복합체", "진생펩타이드", "비타민C 유도체"],
          usage: ["아침, 저녁 크림 단계에서 적당량을 취해 피부결을 따라 부드럽게 펴 발라 줍니다."],
          faq: [
            {
              question: "보태니컬 리뉴얼 크림의 핵심 성분은 무엇인가요?",
              answer: "식물 복합체는 희귀 인삼 사포닌을 농축해 콜라겐 케어를 돕고, 진생펩타이드와 비타민C 유도체는 탄력과 항산화 케어 맥락을 제공합니다."
            },
            {
              question: "보태니컬 리뉴얼 크림의 효과는 얼마나 지속되나요?",
              answer: "사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다 (35~55세 여성 33명 인체 적용 시험)."
            },
            {
              question: "보태니컬 리뉴얼 크림을 다른 제품과 함께 사용하면 효과가 더 좋아지나요?",
              answer: "에센셜 액티베이팅 에센스, 보태니컬 리뉴얼 캡슐 세럼, 보태니컬 리뉴얼 크림 리치와 함께 쓰는 루틴에서 영양, 탄력, 주름 개선 만족도 지표가 함께 제시됩니다."
            },
            {
              question: "보태니컬 리뉴얼 크림은 어떤 피부 고민에 효과가 있나요?",
              answer: "탄력 저하, 주름, 피부 밀도 감소 등 노화 징후에 효과적입니다. 피부 노화지수 -25%, 이마 주름 -36.6%, 리프팅 +103.5%의 결과가 제시됩니다."
            },
            {
              question: "보태니컬 리뉴얼 크림과 보태니컬 리뉴얼 크림 리치의 차이점은 무엇인가요?",
              answer: "보태니컬 리뉴얼 크림은 산뜻한 고밀도 텍스처와 비타민C 유도체를 강조하고, 보태니컬 리뉴얼 크림 리치는 리치 텍스처와 진생레티놀을 강조합니다."
            },
            {
              question: "보태니컬 리뉴얼 크림은 민감한 피부도 사용할 수 있나요?",
              answer: "민감 피부 사용 적합 테스트를 완료해 민감성 피부도 선택 기준으로 참고할 수 있습니다."
            },
            {
              question: "보태니컬 리뉴얼 크림과 퍼밍 크림 EX 중 어떤 것을 선택해야 하나요?",
              answer: "노화 징후가 신경 쓰이기 시작한 고객은 보태니컬 리뉴얼 크림, 탄력 기본기와 보습 장벽 케어를 우선하는 고객은 퍼밍 크림 EX를 비교할 수 있습니다."
            },
            {
              question: "보태니컬 리뉴얼 크림 클래식과 소프트는 어디서 구매할 수 있나요?",
              answer: "2024년 9월 리뉴얼로 단종되었습니다. 기존 클래식 사용자는 보태니컬 리뉴얼 크림 리치, 소프트 사용자는 보태니컬 리뉴얼 크림을 대체 옵션으로 비교할 수 있습니다."
            }
          ],
          reviews: {
            rating: 4.9,
            reviewCount: 840,
            keywords: ["피부결", "만족도", "쫀쫀함"]
          },
          sourceTexts: [
            "60년 인삼과학의 정수 자생력으로 차오른 고밀도 피부 NEW | 보태니컬 리뉴얼 크림 피부 탄력이 개선된 느낌 93.5% 피부 자생력이 강화된 느낌 90.3% 피부 결이 부드러워진 느낌 96.7% ExampleLuxe",
            "18개의 노화 신호 케어 비타민C 유도체, NEW, 보태니컬 리뉴얼 크림",
            "35~55세 여성 33명 인체 적용 시험에서 사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다."
          ],
          semanticFacts: {
            ingredients: ["식물 복합체", "진생펩타이드", "비타민C 유도체"],
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
        url: "https://example.com/products/botanical-renewal-cream"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faqItems = faq.mainEntity as Array<Record<string, any>>;
    const faqText = JSON.stringify(faqItems);
    const concernFaq = faqItems.find((item) => /고민인\s*고객에게[^?？]*(?:적합|효과)|노화|주름|탄력/u.test(String(item.name))) as Record<string, any>;
    const sensitiveFaq = faqItems.find((item) => /민감한?\s*피부/u.test(String(item.name))) as Record<string, any>;
    const concernAnswer = String((concernFaq.acceptedAnswer as Record<string, any>)?.text ?? "");
    const targetCustomer = String((product.additionalProperty as Array<Record<string, any>>)
      .find((item) => item.name === "Target customer")?.value ?? "");

    expect(faqItems.length).toBeLessThanOrEqual(12);
    expect(faqText).not.toMatch(/정보는 어떤 근거|외부 연구나 기사|NEW\s*\||ExampleLuxe|상품 상세 테스트|성분 설명입니다|확인 키워드/);
    expect(faqItems.some((item) => String(item.name).includes("강조되는 성분/기술"))).toBe(false);
    expect(concernFaq).toBeTruthy();
    expect(sensitiveFaq).toBeTruthy();
    expect(concernAnswer).toMatch(/노화 징후|탄력 저하|주름|탄력/);
    expect(faqText).toMatch(/35~55세 여성|인체 적용 시험|팔자주름/);
    expect(targetCustomer).toMatch(/민감 피부/u);
    expect(targetCustomer).not.toMatch(/35~55세|33명/u);
    expect(concernAnswer).not.toMatch(/민감 피부에 적합하며,\s*수분감을 중심|NEW\s*\||ExampleLuxe|상품 상세 테스트|성분 설명입니다|확인 키워드/);
  });
  it("keeps Korean routine FAQ answers from using review expectation text as usage guidance", async () => {
    const reviewExpectation = "아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요";
    const actualUsage = "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.";

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 젠틀 포밍클렌저",
          description: "예시더마 배리어케어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
          category: "클렌저",
          benefits: ["저자극 세안", "피부 장벽"],
          ingredients: ["판테놀", "세라마이드", "BarrierCapsule® 기술"],
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
  it("does not append benefit or conflicting category terms to a product name that already has a product type", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lather that removes impurities while supporting hydration and comfort.",
          images: [
            "https://example.com/cdn/shop/files/SWS_Thumbnail_GCF_1080x1080_200ml.jpg"
          ],
          benefits: ["hydration", "oil control", "Benefits"],
          effects: [
            "AFTER 3 DAYS OF USE 96% AGREED FOAM FEELS GENTLE WITHOUT IRRITATION 86% AGREED PRODUCT THOROUGHLY CLEANSES MAKEUP RESIDUE 83% AGREED SKIN FEELS HYDRATED AFTER CLEANSING 1Based on a 3-day independent consumer study on 30 women 30-49."
          ],
          ingredients: [
            "ExampleLuxe’s proprietary hydro-cleansing formula leaves your skin hydrated and removes grime from pores after cleansing.",
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
                "Botanical Renewal Serum Mini, Korean travel sized serum, product shot.",
                "Botanical Renewal Cream Rich, korean cream, pack shot.",
                "Person applying a skincare product to their hand with text 'Gentle, Non-Stripping Formula' in the corner."
              ],
              imageTexts: [
                {
                  imageUrl: "https://example.com/cdn/shop/files/BRAND.COM_1080x1080_NewCGRSerum_01.Packshot_50ml.jpg",
                  text: "Botanical Renewal Serum Mini, Korean travel sized serum, product shot."
                }
              ]
            }
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/gentle-cleansing-foam?variant=41663478792237"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const serialized = JSON.stringify(result);

    expect(result.content.sections.productName).toBe("Gentle Cleansing Foam");
    expect(product.name).toBe("Gentle Cleansing Foam");
    expect(product.description).toContain("Gentle Cleansing Foam is a cleanser");
    expect(product.description).toContain("hydro-cleansing formula");
    expect(product.description).toContain("hydrated");
    expect(product.description).toContain("In an assessment of 30 women after 3 days of use");
    expect(product.description).toContain("96% of participants agreed");
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
    expect(webPage.description).toContain("introduces the cleanser.");
    expect(webPage.description).not.toContain("introduces the cleanser for customers");
    expect(webPage.description).toMatch(/documents hydration and oil control as product benefits/i);
    expect(webPage.description).not.toMatch(/purchase decisions|official test and measurement results/i);
    expect(webPage.description).not.toMatch(/hydro-cleansing formula|96% of participants agreed/i);
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
    expect(serialized).not.toMatch(/product shot|pack shot|travel sized serum|model applying product|person applying|with text|in the corner|Botanical Renewal Serum Mini|Botanical Renewal Cream Rich/i);
    expect(result.diagnostics.normalizedProduct.sourceTexts.join("\n")).not.toMatch(/product shot|pack shot|model applying product|person applying|with text|in the corner/i);
    expect(result.diagnostics.normalizedProduct.ingredients.join("\n")).not.toMatch(/product shot|pack shot|Concentrated Ginseng/i);
    expect(result.diagnostics.normalizedProduct.benefits).not.toContain("Benefits");
    expect(result.diagnostics.ocrSentences).toHaveLength(0);
  });
  it("keeps varied Korean GEO content from existing product, RAG, and review data when OCR is absent", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 산뜻한 장벽 수분 크림입니다.",
          brand: "EXAMPLEDERMA",
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
  it("derives review-backed CEP recommendation PropertyValues from positive reviews while excluding negative review complaints", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "보태니컬 리뉴얼 크림",
        description: "인삼 사포닌과 콜라겐을 담아 피부 탄력과 보습 케어를 돕는 프리미엄 크림입니다.",
        brand: "예시럭셔리",
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
        brand: "예시럭셔리"
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
      || item.propertyID === "indirectCustomerQuestion" || item.propertyID === "directProductQuestion"
    );
    const serialized = JSON.stringify(reviewCepProperties);
    const faqQuestions = faq.mainEntity.map((item: Record<string, any>) => item.name);
    const queries = result.diagnostics.inferredSearchQueries ?? [];
    const querySerialized = JSON.stringify(queries);
    const ingredientQuery = queries.find((query) =>
      query.kind === "direct" && /주요 성분이나 기술.*역할/.test(query.question)
    );

    expect(reviewCepProperties).toHaveLength(0);
    expect(serialized).toBe("[]");
    // Q&A units are unified into FAQPage + diagnostics; never flat properties.
    expect(reviewQueryProperties).toHaveLength(0);
    expect(queries.length).toBeGreaterThanOrEqual(1);
    expect(queries.some((query) => query.kind === "indirect")).toBe(false);
    expect(ingredientQuery).toBeDefined();
    expect(ingredientQuery?.mentionsProductOrBrand).toBe(true);
    expect(ingredientQuery?.keywords).toContain("인삼 사포닌");
    expect(querySerialized).not.toMatch(/간접 고객 질문|직접 상품 질문|핵심 키워드|CEP|Search intent context|향이 강|아쉬워요|별점/);
    const canonicalIngredientQuestion = faqQuestions.find((question: string) => /보태니컬 리뉴얼 크림의 구성 성분과 효능[·・]?효과/u.test(question));
    expect(canonicalIngredientQuestion).toBeDefined();
    expect(faqQuestions).not.toContain("예시럭셔리 보태니컬 리뉴얼 크림은 어떤 피부 고민과 효능에 적합한가요?");
    expect(faqQuestions.filter((question: string) => /구성 성분과 효능[·・]?효과/.test(question))).toEqual([canonicalIngredientQuestion]);
    expect(result.diagnostics.evidence.some((item) => item.field === "diagnostics.inferredSearchQueries")).toBe(true);
  });
  it("keeps benefit context free of marketing fragments and clinical sample fragments", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Botanical Renewal Serum",
        description: "A serum formulated with Botanical Actives and Retinol for visible plumpness and firmness.",
        category: "Serum",
        benefits: [
          "Formulated with our advanced capsule technology, enriched with Botanical Actives™ and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles, while delivering essential nutrients."
        ],
        effects: [
          "After 6 weeks of use 100% of users showed improvement in: Fine Lines & Wrinkles* Elasticity* Firmness* *Instrumental result, 32 women"
        ],
        ingredients: ["Botanical Actives™", "Retinol"],
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
        url: "https://example.com/products/botanical-renewal-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(product.positiveNotes).toBeUndefined();
    const benefitSurface = `${serialized} ${result.content.sections.benefits}`;
    expect(benefitSurface).toContain("fine lines and wrinkles");
    expect(benefitSurface).toContain("elasticity");
    expect(benefitSurface).toContain("firmness");
    expect(benefitSurface).toContain("plumpness");
    expect(webPage.description).toContain("introduces the serum.");
    expect(webPage.description).not.toContain("introduces the serum for customers");
    expect(webPage.description).toMatch(/lists Botanical Actives.*Retinol.*highlighted formula components.*documents .*fine lines and wrinkles.*product benefits/i);
    expect(webPage.description).toMatch(/Directions place the product in a morning and evening post-toner routine.*One customer review highlights smooth, moisture, firmness, and absorbs/i);
    expect(webPage.description).not.toMatch(/100% of users|32 women/i);
    expect(webPage.description).not.toMatch(/The page states that|The page helps answer|helps answer|Usage guidance covers|product-detail evidence/i);
    expect(product.description).toContain("fine lines and wrinkles");
    expect(product.description).toContain("Botanical Actives");
    expect(product.description).toContain("Retinol");
    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toContain("Use morning and night, after applying toner");
    expect(result.content.sections.howToUse).toContain("Warm three pumps between fingers and apply to your face and neck with upward motions");
    expect(product.description).not.toContain("then warm three pumps");
    expect(product.description).not.toContain("aroun…");
    expect(product.description).not.toContain("making the benefit and ingredient story understandable");
    expect(product.description).not.toContain("product page");
    expect(product.description).toContain("One customer review highlights");
    expect(product.description).not.toMatch(/representative customer reviews|repeated review language/i);
    expect(product.description).toContain("smooth");
    expect(product.description).toContain("moisture");
    expect(product.description).toContain("firmness");
    expect(product.description).toContain("100% of users showed improvement");
    expect(product.description).not.toContain("Source information includes 6 weeks");
    expect(webPage.description).not.toBe(product.description);
    expect(serialized).not.toContain("Formulated with our advanced capsule technology routine");
    expect(serialized).not.toContain("\"name\":\"32 women\"");
  });
  it("keeps first-care style home-usage OCR evidence grounded and removes weak CEP expansion", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Essential Activating Serum",
        description: "A ginseng-powered serum for hydration, visible firmness, fine lines, dullness, and skin texture.",
        category: "Serum",
        benefits: ["hydration", "elasticity", "improves hydration", "smooth texture"],
        effects: [
          "92% AGREE SKIN LOOKS CLEAR AND BRIGHT3 86% AGREE FINE LINES LOOK REDUCED3 96% AGREE SKIN TEXTURE FEELS SMOOTHER3 3Home usage test survey, 600 women, with daily use.",
          "AFTER ONE BOTTLE OF DAILY USE*: 100% users had visible improvement in FINE LINES SKIN ELASTICITY DULLNESS *Instrumental result, 30 subjects, after 8 weeks of daily use ESSENTIAL ACTIVATING SERUM ESSENTIAL ACTIVATING SERUM ExampleLuxe"
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
        usage: ["Warm 2-3 pumps of Essential Activating Serum to the palm of your hands, then apply morning and night."],
        reviews: {
          keywords: ["hydration", "firmness"]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/essential-activating-serum"
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
    const additionalProperties = new Map(product.additionalProperty.map((item: any) => [item.name, item.value]));
    const reportedDetails = String(additionalProperties.get("Reported details"));
    const serialized = JSON.stringify({ webPage, product, faq });

    expect(additionalProperties.get("Target customer")).toBeUndefined();
    expect(additionalProperties.get("Key ingredients")).toContain("500-hour aged ginseng");
    expect(additionalProperties.get("Key ingredients")).toContain("Korean herb extract");
    expect(additionalProperties.get("Key ingredients")).not.toMatch(/with the power of ginseng|^GINSENG(?:,|$)/i);
    expect(additionalProperties.get("Ingredient/effect detail")).toContain("The formula includes 500-hour aged ginseng and Korean herb extract");
    expect(additionalProperties.get("Ingredient/effect detail")).toMatch(/Product information identifies|care benefits/);
    expect(additionalProperties.get("Ingredient/effect detail")).not.toContain("customers comparing visible-aging");
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
    expect(product.positiveNotes).toBeUndefined();
    expect(/hydration/i.test(`${serialized} ${result.content.sections.benefits}`)).toBe(true);
    expect(serialized).not.toMatch(/\bAGREE\b|3Home|SÉRUM|ACTIVATEUR|AFTER ONE BOTTLE|oil-control|sensitive-skin|\+5\. 9|\+9\. 9|\+14\. 5|\b9% agreed|\b5% agreed/i);
    expect(serialized).not.toContain("KEY INGREDIENTS");
  });
  it("does not broaden the recommended skin type from an individual review-like FAQ", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "배리어케어365 크림",
        description: "건조하고 민감한 피부의 장벽 보습을 위한 크림입니다.",
        ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드"],
        benefits: ["피부 장벽 보습", "수분 케어"],
        semanticFacts: {
          ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드"],
          benefits: ["피부 장벽 보습", "수분 케어"],
          effects: ["보습량 증가"],
          skinTypes: ["건조 피부", "민감 피부"],
          usageSteps: [],
          safetyTests: [],
          metricClaims: [],
          evidenceSentences: [],
          ingredientBenefitLinks: []
        },
        faq: [{
          question: "지복합성 피부에 딱인 것 같아 추천해요",
          answer: "끈적임 없이 보습을 잡아주는 느낌입니다."
        }]
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/barriercare365-cream"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const targetCustomer = String(product.additionalProperty.find((item: any) => item.name === "Target customer")?.value ?? "");
    const compositionAnswer = String(faqPage.mainEntity.find((item: any) => /구성 성분과 효능[·・]?효과/u.test(item.name))?.acceptedAnswer?.text ?? "");

    expect(targetCustomer).toMatch(/건조 피부|민감 피부/u);
    expect(targetCustomer).not.toMatch(/복합성 피부/u);
    expect(compositionAnswer).toMatch(/건조하고 민감한 피부/u);
    expect(compositionAnswer).not.toMatch(/복합성 피부/u);
  });
});

describe("generatePdpGeo FAQ citation coverage", () => {
  it("keeps at least four citable FAQ questions when benefit/ingredient/metric/review evidence exists", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 캡슐 토너",
          brand: "EXAMPLEDERMA",
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
              question: "배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
              answer: "배리어케어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 하이드로겔 플로팅 포뮬러 제품입니다."
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
        url: "https://example.com/web/product/view.do?prdSeq=1149"
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
