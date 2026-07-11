import { describe, expect, it } from "vitest";
import { createPdpGeoContentHtml } from "../src/generate";
import type { JsonObject } from "../src/types";
import { validateAndRepairPdpGeoArtifacts, validatePdpGeoArtifacts } from "../src/validate";

describe("validateAndRepairPdpGeoArtifacts", () => {
  it("deduplicates Korean HowTo steps by usage action", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1144#product",
              name: "에스트라 아토베리어365 젠틀 포밍클렌저",
              description: "건조하고 민감한 피부를 위한 저자극 포밍 클렌저입니다."
            },
            {
              "@type": "HowTo",
              "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1144#how-to-use",
              name: "에스트라 아토베리어365 젠틀 포밍클렌저 사용 방법",
              inLanguage: "ko-KR",
              about: {
                "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1144#product"
              },
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  name: "1단계",
                  text: "적당량을 손바닥에 덜어 거품내어 줍니다"
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  name: "2단계",
                  text: "적당량을 덜어 거품을 냅니다"
                },
                {
                  "@type": "HowToStep",
                  position: 3,
                  name: "3단계",
                  text: "얼굴에 마사지하듯 문지릅니다"
                },
                {
                  "@type": "HowToStep",
                  position: 4,
                  name: "4단계",
                  text: "미온수로 깨끗하게 헹굽니다"
                },
                {
                  "@type": "HowToStep",
                  position: 5,
                  name: "5단계",
                  text: "얼굴에 마사지합니다"
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
          description: "건조하고 민감한 피부를 위한 저자극 포밍 클렌저입니다.",
          quickFacts: "제품 유형: 저자극 포밍 클렌저",
          benefits: "저자극 세안",
          ingredients: "판테놀",
          howToUse: [
            "1. 적당량을 손바닥에 덜어 거품내어 줍니다",
            "2. 적당량을 덜어 거품을 냅니다",
            "3. 얼굴에 마사지하듯 문지릅니다",
            "4. 미온수로 깨끗하게 헹굽니다",
            "5. 얼굴에 마사지합니다"
          ].join("\n"),
          faq: "Q. 어떻게 사용하나요?\nA. 적당량을 손바닥에 덜어 거품을 낸 뒤 마사지하고 미온수로 헹굽니다."
        },
        html: ""
      },
      fallbackProductName: "에스트라 아토베리어365 젠틀 포밍클렌저",
      fallbackDescription: "건조하고 민감한 피부를 위한 저자극 포밍 클렌저입니다.",
      locale: "ko-KR"
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;

    expect(howTo.step.map((step: any) => step.text)).toEqual([
      "적당량을 손바닥에 덜어 거품을 냅니다",
      "얼굴에 마사지하듯 문지릅니다",
      "미온수로 깨끗하게 헹굽니다"
    ]);
    expect(howTo.step.map((step: any) => step.position)).toEqual([1, 2, 3]);
    expect(repaired.content.sections.howToUse).toBe([
      "1. 적당량을 손바닥에 덜어 거품을 냅니다",
      "2. 얼굴에 마사지하듯 문지릅니다",
      "3. 미온수로 깨끗하게 헹굽니다"
    ].join("\n"));
  });

  it("removes ingredient, formula, or marketing explanations from Korean HowTo steps", () => {
    const marketingCopy = "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드";
    const sensoryCopy = "끈적임 없이 편안한 마무리감 테스트 수분감이 느껴지는 끈적임 없이 산뜻한 촉촉한 느낌 피부가 진정되는 피부결이 부드러운";
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#product",
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "건조하고 민감한 피부 고객을 위한 장벽 보습 캡슐 토너입니다.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Usage",
                  value: sensoryCopy
                }
              ]
            },
            {
              "@type": "HowTo",
              "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#how-to-use",
              name: "에스트라 아토베리어365 캡슐 토너 사용 방법",
              inLanguage: "ko-KR",
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  name: "1단계",
                  text: "에스트라 아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 하이드로퀄 플로팅 포뮬러 기술을 사용한다"
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  name: "2단계",
                  text: marketingCopy
                },
                {
                  "@type": "HowToStep",
                  position: 3,
                  name: "3단계",
                  text: `캡슐. ${marketingCopy}`
                },
                {
                  "@type": "HowToStep",
                  position: 4,
                  name: "4단계",
                  text: sensoryCopy
                },
                {
                  "@type": "HowToStep",
                  position: 5,
                  name: "5단계",
                  text: "손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바릅니다"
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
          description: "건조하고 민감한 피부 고객을 위한 장벽 보습 캡슐 토너입니다.",
          quickFacts: "제품 유형: 토너",
          benefits: "피부 장벽",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: `1. 에스트라 아토베리어365 캡슐 토너는 PHA 워터에 고밀도 세라마이드 캡슐을 띄운 특허 출원 하이드로퀄 플로팅 포뮬러 기술을 사용한다\n2. ${sensoryCopy}\n3. 손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바릅니다`,
          faq: "Q. 어떻게 사용하나요?\nA. 손바닥에 적당량을 덜어 피부결을 따라 펴 바릅니다."
        },
        html: ""
      },
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "건조하고 민감한 피부 고객을 위한 장벽 보습 캡슐 토너입니다.",
      locale: "ko-KR"
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect((howTo?.step as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(repaired.content.sections.howToUse).toBe("1. 손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바릅니다");
    expect(repaired.content.sections.howToUse).not.toMatch(/하이드로퀄|포뮬러 기술을 사용|PHA 워터에 고밀도 세라마이드 캡슐/);
    expect(repaired.content.sections.howToUse).not.toMatch(/피부 장벽 유사 성분|바르는 순간|세라마이드 캡슐 세라마이드/);
    expect(repaired.content.sections.howToUse).not.toMatch(/끈적임 없이|마무리감 테스트|피부결이 부드러운/);
    expect((product.additionalProperty as Array<Record<string, any>> | undefined)?.some((item) => item.name === "Usage")).not.toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "HowTo.step.text")).toBe(true);
  });

  it("removes ingredient or formula explanations from Japanese HowTo steps", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/products/aestura-capsule-toner#product",
              name: "AESTURA アトバリア365 カプセルトナー",
              description: "乾燥肌や敏感肌向けのバリア保湿カプセルトナーです。"
            },
            {
              "@type": "HowTo",
              "@id": "https://example.com/products/aestura-capsule-toner#how-to-use",
              name: "AESTURA アトバリア365 カプセルトナー 使用方法",
              inLanguage: "ja-JP",
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  name: "1段階",
                  text: "AESTURA アトバリア365 カプセルトナーは特許出願中のハイドロクオールフローティングフォーミュラ処方を使用しています"
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  name: "2段階",
                  text: "手のひらに適量を取り、肌になじませます"
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "AESTURA アトバリア365 カプセルトナー",
          description: "乾燥肌や敏感肌向けのバリア保湿カプセルトナーです。",
          quickFacts: "製品タイプ: 化粧水",
          benefits: "バリア保湿",
          ingredients: "高密度セラミドカプセル",
          howToUse: "1. AESTURA アトバリア365 カプセルトナーは特許出願中のハイドロクオールフローティングフォーミュラ処方を使用しています\n2. 手のひらに適量を取り、肌になじませます",
          faq: "Q. どのように使いますか？\nA. 手のひらに適量を取り、肌になじませます。"
        },
        html: ""
      },
      fallbackProductName: "AESTURA アトバリア365 カプセルトナー",
      fallbackDescription: "乾燥肌や敏感肌向けのバリア保湿カプセルトナーです。",
      locale: "ja-JP"
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");

    expect((howTo?.step as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(repaired.content.sections.howToUse).toBe("1. 手のひらに適量を取り、肌になじませます");
    expect(repaired.content.sections.howToUse).not.toMatch(/ハイドロクオールフローティングフォーミュラ|処方を使用/);
    expect(repaired.validationRepairs.some((repair) => repair.field === "HowTo.step.text")).toBe(true);
  });

  it("normalizes situation-like and question-like PropertyValue names", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#product",
              name: "에스트라 아토베리어365 캡슐 토너",
              brand: {
                "@type": "Brand",
                name: "AESTURA"
              },
              description: "건조하고 민감한 피부 고객을 위한 세라마이드 장벽 보습 캡슐 토너입니다.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "피부가 많이 건조하고 당김이 느껴질 때",
                  value: "에스트라 아토베리어365 캡슐 토너는 피부가 많이 건조하고 당김이 느껴질 때 수분감과 피부 장벽을 기대하는 고객에게 추천할 수 있습니다."
                },
                {
                  "@type": "PropertyValue",
                  name: "피부가 많이 건조하고 당김이 느껴질 때 어떤 제품을 선택하면 좋나요?",
                  value: "에스트라 아토베리어365 캡슐 토너는 건조함과 당김이 고민인 고객이 수분감과 피부 장벽 케어를 비교할 때 참고할 수 있습니다."
                },
                {
                  "@type": "PropertyValue",
                  name: "AESTURA 에스트라 아토베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
                  value: "에스트라 아토베리어365 캡슐 토너는 고밀도 세라마이드 캡슐과 하이드로퀄 플로팅 포뮬러를 중심으로 피부 장벽과 수분감을 설명합니다."
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
          description: "건조하고 민감한 피부 고객을 위한 세라마이드 장벽 보습 캡슐 토너입니다.",
          quickFacts: "주요 성분: 고밀도 세라마이드 캡슐",
          benefits: "수분감과 피부 장벽",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "세안 후 첫 단계에서 사용합니다.",
          faq: "Q. 어떤 피부에 적합한가요?\nA. 건조하고 민감한 피부 고객에게 적합합니다."
        },
        html: ""
      },
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "건조하고 민감한 피부 고객을 위한 세라마이드 장벽 보습 캡슐 토너입니다.",
      locale: "ko-KR"
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;

    expect(properties.map((item) => item.name)).toEqual([
      "Review-derived recommendation context",
      "Indirect customer question",
      "Direct product question"
    ]);
    expect(properties.map((item) => item.propertyID)).toEqual([
      "reviewDerivedRecommendationContext",
      "indirectCustomerQuestion",
      "directProductQuestion"
    ]);
    expect(JSON.stringify(properties)).toContain("피부가 많이 건조하고 당김이 느껴질 때");
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty.name")).toBe(true);
  });
});

describe("validateAndRepairPdpGeoArtifacts FAQ and public text QA", () => {
  const productId = "https://www.aestura.com/web/product/view.do?prdSeq=1149#product";

  function runValidation(graphNodes: any[]) {
    return validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": productId,
              name: "에스트라 아토베리어365 캡슐 토너",
              description: "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다."
            },
            ...graphNodes
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "에스트라 아토베리어365 캡슐 토너",
          description: "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          quickFacts: "제품 유형: 캡슐 토너",
          benefits: "장벽 보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "",
          faq: ""
        },
        html: ""
      },
      fallbackProductName: "에스트라 아토베리어365 캡슐 토너",
      fallbackDescription: "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다.",
      locale: "ko-KR"
    });
  }

  function graphOf(repaired: ReturnType<typeof runValidation>): Array<Record<string, any>> {
    return repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
  }

  it("strips non-answer lead sentences from FAQ answers and keeps the supported fact", () => {
    const repaired = runValidation([
      {
        "@type": "FAQPage",
        "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#faq",
        inLanguage: "ko-KR",
        mainEntity: [
          {
            "@type": "Question",
            name: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "동일 여부는 현재 제품 정보만으로 확인하기 어렵습니다. 에스트라 아토베리어365 캡슐 토너는 PHA 워터에 띄워진 고밀도 세라마이드 캡슐과 하이드로겔 플로팅 포뮬러를 사용한 장벽 보습 토너입니다."
            }
          }
        ]
      }
    ]);
    const faqPage = graphOf(repaired).find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const answer = faqPage.mainEntity[0].acceptedAnswer.text as string;

    expect(answer).not.toMatch(/확인하기 어렵|확인이 어렵|알 수 없습니다/);
    expect(answer).toContain("고밀도 세라마이드 캡슐");
    expect(repaired.validationRepairs.some((repair) => repair.field === "FAQPage.mainEntity.acceptedAnswer.text" && /non-answer/i.test(repair.issue))).toBe(true);
  });

  it("removes FAQ items whose whole answer is a non-answer", () => {
    const repaired = runValidation([
      {
        "@type": "FAQPage",
        "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#faq",
        inLanguage: "ko-KR",
        mainEntity: [
          {
            "@type": "Question",
            name: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "동일 여부는 현재 제품 정보만으로 확인하기 어렵습니다."
            }
          },
          {
            "@type": "Question",
            name: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부에서 장벽 보습과 수분 공급을 원하는 고객에게 적합합니다."
            }
          }
        ]
      }
    ]);
    const faqPage = graphOf(repaired).find((node) => node["@type"] === "FAQPage") as Record<string, any>;

    expect(faqPage.mainEntity).toHaveLength(1);
    expect(faqPage.mainEntity[0].name).toContain("어떤 고객에게 추천");
  });

  it("repairs question-period and comma-period punctuation artifacts in public values", () => {
    const repaired = runValidation([
      {
        "@type": "Product",
        "@id": productId,
        name: "에스트라 아토베리어365 캡슐 토너",
        additionalProperty: [
          {
            "@type": "PropertyValue",
            name: "Direct product question",
            propertyID: "directProductQuestion",
            value: "AESTURA 에스트라 아토베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?. 에스트라 아토베리어365 캡슐 토너는 고밀도 세라마이드 캡슐을 중심으로 장벽 보습을 제공하는 제품입니다."
          },
          {
            "@type": "PropertyValue",
            name: "Clinical result summary",
            value: "시험 대상 미공개 기준 18시간 1회 도포후,.ex vivo 테스트에서 18시간 장벽에서 잔존하는 세라마이드 190%입니다."
          }
        ]
      }
    ]);
    const product = graphOf(repaired).find((node) => node["@type"] === "Product" && Array.isArray(node.additionalProperty)) as Record<string, any>;
    const values = (product.additionalProperty as Array<Record<string, any>>).map((item) => String(item.value));

    expect(values.some((value) => value.includes("무엇인가요? 에스트라"))).toBe(true);
    expect(values.every((value) => !value.includes("?."))).toBe(true);
    expect(values.every((value) => !value.includes(",."))).toBe(true);
  });

  it("deduplicates repeated items in comma-list PropertyValue values", () => {
    const repaired = runValidation([
      {
        "@type": "Product",
        "@id": productId,
        name: "에스트라 아토베리어365 캡슐 토너",
        additionalProperty: [
          {
            "@type": "PropertyValue",
            name: "Recommended skin type",
            value: "민감 피부, 건조 피부, 민감 피부"
          }
        ]
      }
    ]);
    const product = graphOf(repaired).find((node) => node["@type"] === "Product" && Array.isArray(node.additionalProperty)) as Record<string, any>;
    const skinType = (product.additionalProperty as Array<Record<string, any>>).find((item) => item.name === "Recommended skin type");

    expect(skinType?.value).toBe("민감 피부, 건조 피부");
  });

  it("removes malformed image URLs from Product.image", () => {
    const repaired = runValidation([
      {
        "@type": "Product",
        "@id": productId,
        name: "에스트라 아토베리어365 캡슐 토너",
        image: [
          "https://image.aestura.com/upload/product/1149_L.",
          "https://image.aestura.com/upload/product/1149_1098_DSPIMG_S.webp?ver=2026051505"
        ]
      }
    ]);
    const product = graphOf(repaired).find((node) => node["@type"] === "Product" && Array.isArray(node.image)) as Record<string, any>;

    expect(product.image).toEqual([
      "https://image.aestura.com/upload/product/1149_1098_DSPIMG_S.webp?ver=2026051505"
    ]);
  });

  it("removes fully redundant duplicated metric clauses from WebPage descriptions", () => {
    const repaired = runValidation([
      {
        "@type": "WebPage",
        "@id": "https://www.aestura.com/web/product/view.do?prdSeq=1149#webpage",
        name: "에스트라 아토베리어365 캡슐 토너",
        description: "평가 지표: 사용 직후 외부자극인 Tape Stripping에 의한 장벽 손상은 60.5% 회복되었고, 사용 7일 후 외부자극인 Tape Stripping에 의한 장벽 손상은 87.3% 회복되었고, 사용 7일 후 87.3% 회복되었습니다.",
        mainEntity: { "@id": productId }
      }
    ]);
    const webPage = graphOf(repaired).find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const description = String(webPage.description);

    expect(description.match(/87\.3%/g)).toHaveLength(1);
    expect(description).toContain("60.5% 회복");
    expect(description).toMatch(/회복되었습니다\.?$/);
  });
});

describe("read-only validation false-positive regression", () => {
  it("keeps valid Korean product subjects and fl. oz. punctuation without cascading into an HTML mismatch", () => {
    const description = "아토베리어365 크림은 건조하고 민감한 피부 고객을 위한 크림입니다. 이 제품은 고밀도 세라마이드 캡슐로 장벽 보습을 제공한다고 제시됩니다.";
    const sections = {
      productName: "아토베리어365 크림",
      description,
      quickFacts: "옵션은 2.70 fl. oz., 80 mL입니다.",
      benefits: "피부 장벽 케어",
      ingredients: "고밀도 세라마이드 캡슐",
      howToUse: "",
      faq: ""
    };
    const jsonLd: JsonObject = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": "https://example.com/product#webpage",
          name: "아토베리어365 크림",
          description: "아토베리어365 크림 상품 페이지는 크림 상품을 소개합니다. 옵션은 2.70 fl. oz., 80 mL입니다.",
          mainEntity: { "@id": "https://example.com/product#product" }
        },
        {
          "@type": "Product",
          "@id": "https://example.com/product#product",
          name: "아토베리어365 크림",
          description,
          mainEntityOfPage: { "@id": "https://example.com/product#webpage" },
          additionalProperty: [{
            "@type": "PropertyValue",
            name: "Reported details",
            value: "완제품 인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다."
          }]
        }
      ]
    };
    const result = validatePdpGeoArtifacts({
      schemaMarkup: {
        jsonLd,
        scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>`
      },
      content: {
        sections,
        html: createPdpGeoContentHtml(sections, "ko-KR")
      },
      fallbackProductName: sections.productName,
      fallbackDescription: description,
      locale: "ko-KR"
    });

    expect(result.validationWarnings).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/Korean particle or spacing was awkward/u),
      expect.stringMatching(/Description evidence scope did not match/u),
      expect.stringMatching(/Generated HTML was not trusted/u)
    ]));
  });

  it("keeps an official localized-use caution in a suitability FAQ without treating it as a customer review", () => {
    const question = "아토베리어365 크림은 어린아이부터 성인까지 사용할 수 있나요?";
    const answer = "아토베리어365 크림은 민감하고 연약한 피부가 사용할 수 있게 개발된 제품으로, 0세부터 성인까지 누구나 사용 가능한 제품이라고 안내됩니다. 공식 상품 정보에서 피부 장벽 관리에 도움을 주는 제품으로 설명됩니다. 다만 피부 상태를 정확히 알기 어려운 경우에는 국소 부위에 먼저 사용해보는 것을 권장한다는 안내도 함께 제시됩니다.";
    const faq = `Q. ${question}\nA. ${answer}`;
    const sections = {
      productName: "아토베리어365 크림",
      description: "아토베리어365 크림은 민감하고 연약한 피부를 위한 보습 크림입니다.",
      quickFacts: "",
      benefits: "",
      ingredients: "",
      howToUse: "",
      faq
    };
    const jsonLd: JsonObject = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": "https://example.com/product#webpage",
          name: "아토베리어365 크림",
          mainEntity: { "@id": "https://example.com/product#product" }
        },
        {
          "@type": "Product",
          "@id": "https://example.com/product#product",
          name: "아토베리어365 크림",
          description: sections.description,
          mainEntityOfPage: { "@id": "https://example.com/product#webpage" }
        },
        {
          "@type": "FAQPage",
          "@id": "https://example.com/product#faq",
          isPartOf: { "@id": "https://example.com/product#webpage" },
          about: { "@id": "https://example.com/product#product" },
          mainEntity: [{
            "@type": "Question",
            name: question,
            acceptedAnswer: {
              "@type": "Answer",
              text: answer
            }
          }]
        }
      ]
    };
    const result = validatePdpGeoArtifacts({
      schemaMarkup: {
        jsonLd,
        scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>`
      },
      content: {
        sections,
        html: createPdpGeoContentHtml(sections, "ko-KR")
      },
      fallbackProductName: sections.productName,
      fallbackDescription: sections.description,
      locale: "ko-KR"
    });

    expect(sections.faq).toContain("국소 부위에 먼저 사용해보는 것을 권장");
    expect(result.validationWarnings).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/raw customer review wording/u),
      expect.stringMatching(/Korean particle or spacing was awkward/u),
      expect.stringMatching(/FAQ section items did not use supported Q\/A markers/u),
      expect.stringMatching(/Generated HTML was not trusted/u)
    ]));
  });
});
