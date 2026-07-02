import { describe, expect, it } from "vitest";
import {
  createMockGeoCitationContentInput,
  generateGeoCitationContent
} from "../src";

describe("generateGeoCitationContent", () => {
  it("generates a citation-ready Reddit artifact with diagnostics", async () => {
    const run = await generateGeoCitationContent(createMockGeoCitationContentInput());

    expect(run.result.artifact.surface).toBe("reddit");
    expect(run.result.artifact.title).toMatch(/\?|noticed|looked|compared/i);
    expect(run.result.artifact.bodyMarkdown).toContain("Short version");
    expect(run.result.artifact.bodyMarkdown).toContain("What seems supported");
    expect(run.result.artifact.bodyMarkdown).toContain("Question for people");
    expect(run.result.artifact.bodyMarkdown).not.toMatch(/buy now|shop now|limited offer/i);
    expect(run.result.brief.answerChunks.length).toBeGreaterThan(0);
    expect(run.result.strategy.searchIntent.length).toBeGreaterThan(0);
    expect(run.result.diagnostics.mandatoryRagDocuments).toContain("citation-ready-content-contract_v1.md");
    expect(run.diagnostics).toBe(run.result.diagnostics);
    expect(run.result.diagnostics.surfaceRagDocuments).toContain("reddit-content-guidelines_v1.md");
    expect(run.result.diagnostics.evidence.some((item) => item.field === "readiness.geoCitation")).toBe(true);
    expect(run.result.diagnostics.evidence.some((item) => item.field === "rag.mandatory" && item.source === "rag")).toBe(true);
    expect(run.result.diagnostics.ragUsage.length).toBeGreaterThan(0);
    expect(run.result.diagnostics.runtimeUsage.provider).toBe("mock");
    expect(run.result.diagnostics.runtimeUsage.counts.answerChunks).toBe(run.result.brief.answerChunks.length);
    expect(run.result.diagnostics.usedEvidence.length).toBeGreaterThan(0);
    expect(run.result.diagnostics.recommendations).toEqual([]);
    expect(run.result.diagnostics.promotionalToneScore).toBeLessThan(0.5);
    expect(run.result.diagnostics.geoCitationReadiness.passed).toBe(true);
    expect(run.result.diagnostics.geoCitationReadiness.score).toBeGreaterThanOrEqual(0.78);
    expect(run.result.diagnostics.geoCitationReadiness.structureSignals).toEqual(expect.arrayContaining([
      "answer-ready-title",
      "short-version-chunks",
      "claim-evidence-language",
      "source-type-separation",
      "caveat-limitation",
      "comparison-context",
      "community-question",
      "anti-promo",
      "freshness-signal"
    ]));
    expect(run.result.diagnostics.geoCitationReadiness.keywordCoverage.present).toEqual(expect.arrayContaining([
      "Hydra Barrier Cream",
      "moisturizer",
      "hydration",
      "Ceramide"
    ]));
    expect(run.process.map((step) => step.id)).toEqual([
      "input",
      "normalize",
      "mandatory-rag-load",
      "surface-rag-load",
      "evidence-normalize",
      "chunk",
      "retrieve",
      "rerank",
      "brief",
      "generate",
      "validate",
      "repair",
      "artifact"
    ]);
    expect(run.process.every((step) => step.status === "done")).toBe(true);
  });

  it("repairs Reddit output into paste-ready public copy", async () => {
    const run = await generateGeoCitationContent({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles.",
        category: "serum",
        benefits: [
          "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles."
        ],
        ingredients: [
          "KOREAN GINSENG ACTIVES, GINSENG PEPTIDE, GINSENG CAPSULES WITH RETINOL. INGREDIENTS: WATER / AQUA / EAU, BUTYLENE GLYCOL, GLYCERIN, PHENOXYETHANOL, SODIUM HYALURONATE CROSSPOLYMER, RETINOL, NIACINAMIDE FORMULATED WITHOUT: Parabens, Formaldehydes."
        ],
        usage: ["Use morning and night, after applying toner."]
      },
      source: {
        type: "manual-json",
        observedAt: "2026-07-01T06:58:00.610Z"
      },
      target: {
        surface: "reddit",
        audience: "상품을 비교하고 근거를 확인하려는 Reddit 사용자",
        communityOrChannelHint: "reddit"
      }
    }, {
      customDraftWriter: {
        async writeRedditArtifact() {
          return {
            artifact: {
              surface: "reddit",
              title: "Is Concentrated Ginseng Rejuvenating Serum worth considering for Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles?",
              bodyMarkdown: [
                "## Short version",
                "- Concentrated Ginseng Rejuvenating Serum appears most relevant for 상품을 비교하고 근거를 확인하려는 Reddit 사용자. Caveat: Review patterns are useful signals, but they do not prove the product will work the same for everyone.",
                "- Review patterns are useful signals, but they do not prove the product will work the same for everyone. Caveat: Review patterns are useful signals, but they do not prove the product will work the same for everyone.",
                "",
                "## What seems supported",
                "The most supportable point is: Formulated with our advanced capsule technology. Evidence refs: product:profile, extractor-rag-1, extractor-rag-14.",
                "",
                "## Worth comparing against",
                "- Check whether alternatives use similar ingredients such as KOREAN GINSENG ACTIVES, GINSENG PEPTIDE, GINSENG CAPSULES WITH RETINOL. INGREDIENTS: WATER / AQUA / EAU, BUTYLENE GLYCOL, GLYCERIN, PHENOXYETHANOL, SODIUM HYALURONATE CROSSPOLYMER, RETINOL, NIACINAMIDE FORMULATED WITHOUT: Parabens, Formaldehydes.",
                "",
                "Question for people who have looked at similar products: What would you verify first?"
              ].join("\n"),
              flairSuggestion: "Discussion",
              subredditFitNotes: [],
              disclosureNote: "",
              commentSeeds: ["What would you verify first?"]
            }
          };
        }
      }
    });
    const publicText = `${run.result.artifact.title}\n${run.result.artifact.bodyMarkdown}`;

    expect(run.result.artifact.title.length).toBeLessThanOrEqual(120);
    expect(run.result.artifact.title).toBe("Is Concentrated Ginseng Rejuvenating Serum worth considering for fine lines and wrinkles?");
    expect(publicText).not.toMatch(/Evidence refs?|product:profile|extractor-rag|상품을 비교하고/i);
    expect(publicText).not.toMatch(/\bINGREDIENTS?:|FORMULATED WITHOUT|WATER \/ AQUA \/ EAU/i);
    expect(publicText.match(/Review patterns are useful signals/g)).toHaveLength(1);
    expect(run.result.artifact.bodyMarkdown.trim()).toMatch(/\?$/);
    expect(run.result.diagnostics.channelWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Reddit title was repaired"),
      expect.stringContaining("Reddit body was repaired")
    ]));
  });

  it("keeps PDP marketing copy from leaking into the default Reddit draft", async () => {
    const run = await generateGeoCitationContent({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives™ and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles, while delivering essential nutrients.",
        category: "serum",
        benefits: [
          "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives™ and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles, while delivering essential nutrients."
        ],
        ingredients: [
          "KOREAN GINSENG ACTIVES, GINSENG PEPTIDE, GINSENG CAPSULES WITH RETINOL. INGREDIENTS: WATER / AQUA / EAU, BUTYLENE GLYCOL, GLYCERIN, PHENOXYETHANOL, SODIUM HYALURONATE CROSSPOLYMER, RETINOL, NIACINAMIDE FORMULATED WITHOUT: Parabens, Formaldehydes."
        ],
        usage: ["Use morning and night, after applying toner."],
        reviews: {
          keywords: ["fine lines", "plumpness"]
        }
      },
      source: {
        type: "manual-json",
        observedAt: "2026-07-01T06:58:00.610Z"
      },
      target: {
        surface: "reddit",
        locale: "en-US",
        audience: "상품을 비교하고 근거를 확인하려는 Reddit 사용자",
        communityOrChannelHint: "reddit"
      },
      strategy: {
        variants: {
          seed: "pdp-marketing-copy"
        }
      }
    });
    const publicText = `${run.result.artifact.title}\n${run.result.artifact.bodyMarkdown}`;

    expect(publicText).not.toMatch(/상품을 비교하고|Formulated with|This powerhouse|melts into skin|essential nutrients|nutrients\.\?|\.\.|00\. 610Z/i);
    expect(publicText).not.toMatch(/^## .+\n\s*(?:##|$)/m);
    expect(publicText).toContain("fine lines and wrinkles");
    expect(publicText).toContain("Based on product and evidence signals available as of 2026-07-01.");
  });

  it("can create different natural Reddit angles for the same product when no seed is fixed", async () => {
    const input = createMockGeoCitationContentInput();
    input.strategy = {
      ...input.strategy,
      variants: undefined
    };
    const first = await generateGeoCitationContent(input);
    const second = await generateGeoCitationContent(input);

    expect(first.result.diagnostics.variantStrategy.variantId).not.toBe(second.result.diagnostics.variantStrategy.variantId);
  });
});
