import { describe, expect, it } from "vitest";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

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
});
