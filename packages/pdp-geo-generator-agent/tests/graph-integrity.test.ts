import { describe, expect, it } from "vitest";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";
import type { JsonObject } from "../src/types";

const baseId = "https://example.com/products/barrier-serum";

function validate(input: {
  graph: JsonObject[];
  faq?: string;
  howToUse?: string;
  locale?: "ko-KR" | "ja-JP" | "en-US" | "en-GB";
}) {
  const locale = input.locale ?? "en-US";
  return validateAndRepairPdpGeoArtifacts({
    locale,
    fallbackProductName: "Barrier Serum",
    fallbackDescription: "Barrier Serum is a hydrating serum for dry skin.",
    schemaMarkup: {
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": input.graph
      },
      scriptTag: ""
    },
    content: {
      sections: {
        productName: "Barrier Serum",
        description: "Barrier Serum is a hydrating serum for dry skin.",
        quickFacts: "Product type: serum",
        benefits: "Hydration",
        ingredients: "Ceramide",
        howToUse: input.howToUse ?? "",
        faq: input.faq ?? ""
      },
      html: "<div class=\"geo-content-accordion\"></div>"
    }
  });
}

function graphOf(result: ReturnType<typeof validate>): Array<Record<string, any>> {
  return result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
}

describe("post-validation schema graph integrity", () => {
  it("removes empty FAQPage and HowTo nodes, their local references, and their visible panels", () => {
    const faqId = `${baseId}#faq`;
    const howToId = `${baseId}#how-to-use`;
    const externalId = "https://support.example.org/guides/serum";
    const result = validate({
      graph: [
        {
          "@type": "WebPage",
          "@id": `${baseId}#webpage`,
          name: "Barrier Serum",
          description: "This product page describes Barrier Serum.",
          hasPart: [{ "@id": faqId }, { "@id": howToId }, { "@id": externalId }]
        },
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        },
        {
          "@type": "FAQPage",
          "@id": faqId,
          mainEntity: [{
            "@type": "Question",
            name: "What is the unsupported claim?",
            acceptedAnswer: { "@type": "Answer", text: "" }
          }]
        },
        {
          "@type": "HowTo",
          "@id": howToId,
          step: [{
            "@type": "HowToStep",
            text: "Barrier Serum supports hydration and a smooth finish."
          }]
        }
      ],
      faq: "Q. What is the unsupported claim?\nA. Unsupported copy",
      howToUse: "Barrier Serum supports hydration and a smooth finish."
    });

    const graph = graphOf(result);
    const webPage = graph.find((node) => node["@type"] === "WebPage");

    expect(graph.some((node) => node["@type"] === "FAQPage")).toBe(false);
    expect(graph.some((node) => node["@type"] === "HowTo")).toBe(false);
    expect(webPage?.hasPart).toEqual([{ "@id": externalId }]);
    expect(result.content.sections.faq).toBe("");
    expect(result.content.sections.howToUse).toBe("");
    expect(result.content.html).toBe("");
    expect(result.validationRepairs.map((repair) => repair.field)).toEqual(expect.arrayContaining([
      "FAQPage",
      "HowTo",
      "WebPage.hasPart",
      "content.sections.faq",
      "content.sections.howToUse"
    ]));
  });

  it("keeps valid and external hasPart references while removing a missing local fragment", () => {
    const faqId = `${baseId}#faq`;
    const externalId = "https://support.example.org/guides/serum#usage";
    const result = validate({
      graph: [
        {
          "@type": "WebPage",
          "@id": `${baseId}#webpage`,
          name: "Barrier Serum",
          description: "This product page describes Barrier Serum.",
          hasPart: [{ "@id": faqId }, { "@id": `${baseId}#missing` }, { "@id": externalId }]
        },
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        },
        {
          "@type": "FAQPage",
          "@id": faqId,
          mainEntity: [{
            "@type": "Question",
            name: "What does Barrier Serum support?",
            acceptedAnswer: { "@type": "Answer", text: "Barrier Serum supports hydration." }
          }]
        }
      ]
    });

    const webPage = graphOf(result).find((node) => node["@type"] === "WebPage");
    expect(webPage?.hasPart).toEqual([{ "@id": faqId }, { "@id": externalId }]);
    expect(result.validationRepairs.some((repair) => repair.field === "WebPage.hasPart")).toBe(true);
  });

  it("removes a dangling local hasPart reference when it is represented as a single object", () => {
    const result = validate({
      graph: [
        {
          "@type": "WebPage",
          "@id": `${baseId}#webpage`,
          name: "Barrier Serum",
          description: "This product page describes Barrier Serum.",
          hasPart: { "@id": `${baseId}#missing` }
        },
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        }
      ]
    });

    const webPage = graphOf(result).find((node) => node["@type"] === "WebPage");
    expect(webPage).not.toHaveProperty("hasPart");
    expect(result.validationRepairs.some((repair) => repair.field === "WebPage.hasPart")).toBe(true);
  });

  it("rebuilds visible FAQ and retains a valid single-step HowTo with matching visible usage", () => {
    const validQuestion = "What does Barrier Serum support?";
    const validAnswer = "Barrier Serum supports hydration for dry skin.";
    const validStep = "Apply one pump to clean skin morning and night.";
    const result = validate({
      graph: [
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        },
        {
          "@type": "FAQPage",
          "@id": `${baseId}#faq`,
          mainEntity: [
            {
              "@type": "Question",
              name: "Broken question",
              acceptedAnswer: { "@type": "Answer", text: "" }
            },
            {
              "@type": "Question",
              name: validQuestion,
              acceptedAnswer: { "@type": "Answer", text: validAnswer }
            }
          ]
        },
        {
          "@type": "HowTo",
          "@id": `${baseId}#how-to-use`,
          name: "How to use Barrier Serum",
          step: [
            { "@type": "HowToStep", text: "Ceramide supports the formula story." },
            { "@type": "HowToStep", text: validStep }
          ]
        }
      ],
      faq: "Q. Broken question\nA. Stale visible answer",
      howToUse: `1. ${validStep}`
    });

    expect(result.content.sections.faq).toBe(`Q. ${validQuestion}\nA. ${validAnswer}`);
    expect(result.content.sections.howToUse).toBe(`1. ${validStep}`);
    expect(result.content.html).toBe("");
    const howTo = graphOf(result).find((node) => node["@type"] === "HowTo");
    expect(howTo).toBeDefined();
    expect(howTo?.step).toEqual([expect.objectContaining({ position: 1, text: validStep })]);
  });

  it("removes a multi-step HowTo without a concrete goal", () => {
    const result = validate({
      graph: [
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        },
        {
          "@type": "HowTo",
          "@id": `${baseId}#how-to-use`,
          step: [
            { "@type": "HowToStep", position: 1, text: "Apply one pump to clean skin." },
            { "@type": "HowToStep", position: 2, text: "Press gently until absorbed." }
          ]
        }
      ],
      howToUse: "1. Apply one pump to clean skin.\n2. Press gently until absorbed."
    });

    expect(graphOf(result).some((node) => node["@type"] === "HowTo")).toBe(false);
    expect(result.content.sections.howToUse).toContain("Apply one pump to clean skin.");
    expect(result.validationRepairs.some((repair) =>
      repair.field === "HowTo" && /missing a concrete goal name/u.test(repair.issue)
    )).toBe(true);
  });

  it("records and repairs non-contiguous HowTo positions in source array order", () => {
    const result = validate({
      graph: [
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "Barrier Serum",
          description: "Barrier Serum is a hydrating serum for dry skin."
        },
        {
          "@type": "HowTo",
          "@id": `${baseId}#how-to-use`,
          name: "How to use Barrier Serum",
          step: [
            { "@type": "HowToStep", position: 2, text: "Apply one pump to clean skin." },
            { "@type": "HowToStep", position: 1, text: "Press gently until absorbed." }
          ]
        }
      ]
    });
    const howTo = graphOf(result).find((node) => node["@type"] === "HowTo");
    const steps = howTo?.step as Array<Record<string, unknown>>;

    expect(steps.map((step) => step.position)).toEqual([1, 2]);
    expect(result.validationRepairs.some((repair) => repair.field === "HowTo.step.position")).toBe(true);
  });

  it("normalizes localized CreativeWork inLanguage values to the artifact locale", () => {
    const result = validate({
      locale: "ko-KR",
      graph: [
        {
          "@type": "WebPage",
          "@id": `${baseId}#webpage`,
          inLanguage: "en-US",
          name: "배리어 세럼",
          description: "배리어 세럼 상품 페이지입니다."
        },
        {
          "@type": "Product",
          "@id": `${baseId}#product`,
          name: "배리어 세럼",
          description: "건조한 피부를 위한 보습 세럼입니다."
        },
        {
          "@type": "FAQPage",
          "@id": `${baseId}#faq`,
          mainEntity: [{
            "@type": "Question",
            name: "어떤 피부에 적합한가요?",
            acceptedAnswer: { "@type": "Answer", text: "건조한 피부의 보습 관리에 적합합니다." }
          }]
        },
        {
          "@type": "HowTo",
          "@id": `${baseId}#how-to-use`,
          name: "배리어 세럼 사용 방법",
          inLanguage: "ja-JP",
          step: [
            { "@type": "HowToStep", position: 1, text: "세안 후 한 펌프를 얼굴에 펴 바릅니다." },
            { "@type": "HowToStep", position: 2, text: "손바닥으로 가볍게 눌러 흡수시킵니다." }
          ]
        }
      ]
    });

    const localizedNodes = graphOf(result).filter((node) => ["WebPage", "FAQPage", "HowTo"].includes(node["@type"]));
    expect(localizedNodes).toHaveLength(3);
    expect(localizedNodes.every((node) => node.inLanguage === "ko-KR")).toBe(true);
    expect(result.validationRepairs.filter((repair) => repair.field.endsWith(".inLanguage"))).toHaveLength(3);
  });

  it("preserves visible FAQ and usage content when optional schema nodes were intentionally omitted", () => {
    const faq = "Q. What does Barrier Serum support?\nA. It supports hydration.";
    const howToUse = "Apply one pump to clean skin.";
    const result = validate({
      graph: [{
        "@type": "Product",
        "@id": `${baseId}#product`,
        name: "Barrier Serum",
        description: "Barrier Serum is a hydrating serum for dry skin."
      }],
      faq,
      howToUse
    });

    expect(result.content.sections.faq).toContain("What does Barrier Serum support?");
    expect(result.content.sections.howToUse).toContain("Apply one pump to clean skin.");
    expect(result.content.html).toBe("");
  });
});
