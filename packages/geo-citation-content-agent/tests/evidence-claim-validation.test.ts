import { describe, expect, it } from "vitest";
import {
  createMockGeoCitationContentInput,
  generateGeoCitationContent,
  type GeoCitationDraftWriter
} from "../src";

describe("evidence and claim validation", () => {
  it("repairs direct Reddit sales CTAs and flags strong unsupported claims", async () => {
    const writer: GeoCitationDraftWriter = {
      async writeRedditArtifact() {
        return {
          artifact: {
            surface: "reddit",
            title: "Buy now: is Hydra Barrier Cream a miracle?",
            bodyMarkdown: [
              "It will cure acne.",
              "Buy now from the brand.",
              "What would you verify before trusting this?"
            ].join("\n"),
            subredditFitNotes: [],
            commentSeeds: ["What would you verify before trusting this?"]
          }
        };
      }
    };

    const run = await generateGeoCitationContent(createMockGeoCitationContentInput(), {
      customDraftWriter: writer
    });

    expect(run.result.artifact.title).not.toMatch(/buy now/i);
    expect(run.result.artifact.bodyMarkdown).not.toMatch(/buy now/i);
    expect(run.result.diagnostics.channelWarnings).toContain("Direct sales CTA or promotional phrase was detected and repaired.");
    expect(run.result.diagnostics.unsupportedClaims.some((claim) => claim.includes("cure"))).toBe(true);
    expect(run.result.diagnostics.evidence.some((item) => item.field === "validation.unsupportedClaims")).toBe(true);
    expect(run.result.diagnostics.recommendations.some((item) => item.field === "claims")).toBe(true);
    expect(run.result.diagnostics.recommendations.some((item) => item.field === "geoCitationReadiness")).toBe(true);
    expect(run.result.diagnostics.geoCitationReadiness.passed).toBe(false);
    expect(run.result.diagnostics.geoCitationReadiness.warnings.some((warning) => warning.includes("Chunkable short version"))).toBe(true);
    expect(run.result.diagnostics.geoCitationReadiness.keywordCoverage.missing.length).toBeGreaterThan(0);
  });
});
