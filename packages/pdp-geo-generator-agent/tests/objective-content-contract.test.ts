import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import type { JsonValue, PdpGeoGenerationRun } from "../src/types";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";
import {
  ineligibleHowToCases,
  japaneseLocalePurityInput,
  sensibleDescriptionInput,
  sparseFaqInput
} from "./fixtures/objective-content-contract-cases";

type GraphNode = Record<string, JsonValue>;

function graphOf(run: PdpGeoGenerationRun): GraphNode[] {
  const graph = run.result.schemaMarkup.jsonLd["@graph"];
  return Array.isArray(graph) ? graph.filter(isGraphNode) : [];
}

function isGraphNode(value: JsonValue | undefined): value is GraphNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeOf(graph: GraphNode[], type: string): GraphNode | undefined {
  return graph.find((node) => node["@type"] === type);
}

function stringField(node: GraphNode | undefined, field: string): string {
  const value = node?.[field];
  return typeof value === "string" ? value : "";
}

function faqEntries(graph: GraphNode[]): Array<{ question: string; answer: string }> {
  const mainEntity = nodeOf(graph, "FAQPage")?.mainEntity;
  if (!Array.isArray(mainEntity)) {
    return [];
  }
  return mainEntity.filter(isGraphNode).map((item) => {
    const acceptedAnswer = isGraphNode(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
    return {
      question: typeof item.name === "string" ? item.name : "",
      answer: typeof acceptedAnswer?.text === "string" ? acceptedAnswer.text : ""
    };
  }).filter((item) => item.question && item.answer);
}

function normalizeIntentText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, " ").trim();
}

function countMatches(values: string[], pattern: RegExp): number {
  return values.filter((value) => pattern.test(value)).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("objective GEO content contracts", () => {
  describe("HowTo eligibility", () => {
    it.each(ineligibleHowToCases)("omits HowTo for $label", async ({ input }) => {
      const run = await generatePdpGeo(input);
      const graph = graphOf(run);
      const webPage = nodeOf(graph, "WebPage");
      const hasPart = Array.isArray(webPage?.hasPart) ? webPage.hasPart.filter(isGraphNode) : [];

      expect(nodeOf(graph, "HowTo")).toBeUndefined();
      expect(hasPart.some((part) =>
        typeof part["@id"] === "string" && /#how-to-use$/.test(part["@id"])
      )).toBe(false);
    });
  });

  it("does not manufacture filler or overlapping FAQ intents from sparse evidence", async () => {
    const run = await generatePdpGeo(sparseFaqInput);
    const entries = faqEntries(graphOf(run));
    const questions = entries.map((item) => item.question);
    const normalizedQuestions = questions.map(normalizeIntentText);

    // The fixture supports hydration/dryness and one review use-feel intent. It does not
    // support a broad FAQ catalogue or a sensitive-skin recommendation.
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(new Set(normalizedQuestions).size).toBe(normalizedQuestions.length);
    expect(countMatches(questions, /reviews?|customer reviews?/i)).toBeLessThanOrEqual(1);
    expect(entries.map((item) => `${item.question} ${item.answer}`).join("\n")).not.toMatch(/sensitive skin/i);
  });

  it("omits empty FAQ/HowTo panels instead of publishing insufficiency filler", async () => {
    const run = await generatePdpGeo({
      product: { name: "Plain Serum", description: "A simple serum." },
      hints: { locale: "en-US" }
    });

    expect(run.result.content.sections.faq).toBe("");
    expect(run.result.content.sections.howToUse).toBe("");
    expect(run.result.content.html).not.toMatch(/>\s*FAQ\s*</);
    expect(run.result.content.html).not.toMatch(/>\s*How to use\s*</);
  });

  it("does not turn a Retinol ingredient into an unsupported capsule format", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Retinol Night Serum",
        description: "A night serum with Retinol.",
        ingredients: ["Retinol"],
        benefits: ["nighttime skin care"]
      },
      hints: { locale: "en-US" }
    });
    const publicOutput = `${JSON.stringify(run.result.schemaMarkup.jsonLd)}\n${run.result.content.html}`;

    expect(publicOutput).toContain("Retinol");
    expect(publicOutput).not.toMatch(/Retinol-infused capsules/i);
  });

  it("filters Hangul sentence frames from English FAQ output", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Hydra Serum",
        description: "A hydrating serum for dry skin.",
        benefits: ["hydration"],
        faq: [{
          question: "What does Hydra Serum support?",
          answer: "이 제품은 dry skin에 hydration을 제공합니다."
        }]
      },
      hints: { locale: "en-US" }
    });

    expect(faqEntries(graphOf(run)).map((item) => `${item.question} ${item.answer}`).join(" ")).not.toMatch(/[가-힣]/u);
  });

  it("keeps target-locale public FAQ copy free of English sentence frames", async () => {
    const run = await generatePdpGeo(japaneseLocalePurityInput);
    const graph = graphOf(run);
    const entries = faqEntries(graph);
    const publicFaqText = entries.map((item) => `${item.question}\n${item.answer}`).join("\n");
    const englishSentenceFrame = /\b(?:when|which|what|positive reviews?|customer reviews?|shoppers?|should shoppers|product is|product page|formula highlights|skin texture|daily use|routine)\b/i;

    expect(run.result.locale).toBe("ja-JP");
    expect(entries.length).toBeGreaterThan(0);
    expect(publicFaqText).not.toMatch(englishSentenceFrame);
    for (const node of graph) {
      if (node.inLanguage !== undefined) {
        expect(node.inLanguage).toBe("ja-JP");
      }
    }
  });

  it("prunes empty semantic container nodes and their WebPage references", () => {
    const productId = "https://example.com/products/hydra#product";
    const faqId = "https://example.com/products/hydra#faq";
    const howToId = "https://example.com/products/hydra#how-to-use";
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": productId,
              name: "Hydra Serum",
              description: "Hydra Serum is a hydrating serum."
            },
            {
              "@type": "WebPage",
              "@id": "https://example.com/products/hydra#webpage",
              name: "Hydra Serum",
              description: "This Hydra Serum product page introduces the product.",
              mainEntity: { "@id": productId },
              hasPart: [{ "@id": faqId }, { "@id": howToId }]
            },
            {
              "@type": "FAQPage",
              "@id": faqId,
              mainEntity: []
            },
            {
              "@type": "HowTo",
              "@id": howToId,
              name: "How to use Hydra Serum",
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  text: "The formula uses ceramide technology for hydration."
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        html: "",
        sections: {
          productName: "Hydra Serum",
          description: "Hydra Serum is a hydrating serum.",
          quickFacts: "Product type: serum",
          benefits: "- hydration",
          ingredients: "- ceramide",
          howToUse: "1. The formula uses ceramide technology for hydration.",
          faq: ""
        }
      },
      fallbackProductName: "Hydra Serum",
      fallbackDescription: "Hydra Serum is a hydrating serum.",
      locale: "en-US"
    });
    const graph = repaired.schemaMarkup.jsonLd["@graph"];
    const nodes = Array.isArray(graph) ? graph.filter(isGraphNode) : [];
    const webPage = nodeOf(nodes, "WebPage");
    const hasPart = Array.isArray(webPage?.hasPart) ? webPage.hasPart.filter(isGraphNode) : [];
    const graphIds = new Set(nodes.flatMap((node) =>
      typeof node["@id"] === "string" ? [node["@id"]] : []
    ));

    expect(nodeOf(nodes, "FAQPage")).toBeUndefined();
    expect(nodeOf(nodes, "HowTo")).toBeUndefined();
    expect(hasPart.map((part) => part["@id"])).not.toEqual(expect.arrayContaining([faqId, howToId]));
    expect(hasPart.every((part) =>
      typeof part["@id"] === "string" && graphIds.has(part["@id"])
    )).toBe(true);
  });

  it("keeps Product and WebPage descriptions distinct, public, and entity-sensible", async () => {
    const run = await generatePdpGeo(sensibleDescriptionInput);
    const graph = graphOf(run);
    const productDescription = stringField(nodeOf(graph, "Product"), "description");
    const webPageDescription = stringField(nodeOf(graph, "WebPage"), "description");
    const productName = "하이드라 배리어 세럼";
    const brandName = "테스트랩";
    const entityAsFormulaIngredient = new RegExp(
      `(?:${escapeRegExp(productName)}|${escapeRegExp(brandName)})[^.!?。！？]{0,32}(?:담아|함유|포함|배합)`,
      "u"
    );

    expect(productDescription).not.toMatch(/상품\s*페이지|제품\s*페이지|상세\s*페이지/u);
    expect(webPageDescription).toMatch(/상품\s*페이지|제품\s*페이지|상세\s*페이지/u);
    expect(normalizeIntentText(webPageDescription)).not.toBe(normalizeIntentText(productDescription));
    expect(productDescription).toBe(run.result.content.sections.description);
    expect(productDescription).toMatch(/세라마이드/u);
    expect(productDescription).toMatch(/판테놀/u);
    expect(productDescription).not.toMatch(entityAsFormulaIngredient);
    expect(webPageDescription).not.toMatch(entityAsFormulaIngredient);
    expect(`${productDescription}\n${webPageDescription}`).not.toMatch(/(?:RAG|GEO|citation-ready|schema optimization|평가\s*지표\s*:)/i);
  });
});
