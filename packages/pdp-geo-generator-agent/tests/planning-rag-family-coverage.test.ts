import { describe, expect, it } from "vitest";
import { createPlanningPrompt } from "../src/prompts/content-planning";
import { exampleluxeNormalizedProduct } from "./fixtures/exampleluxe-normalized-product";
import type { PdpGeoContentPlanningRequest, PdpGeoRagKind, PdpGeoRetrievedChunk, PdpProductSignal } from "../src/types";
import { planningRequest } from "./support/planning";

/**
 * The planner sees a small slice of the retrieved context — five chunks by
 * default — chosen by reserving one per policy family and then filling by
 * retrieval score. Because the reserved families already filled the whole
 * budget, any family outside that list could never reach the planner even when
 * retrieval had given it a coverage seat.
 *
 * The evidence cards were in exactly that position: coverageRagKindOrder seats
 * them because geo-research defers every research number and its provenance to
 * them, yet the planner never saw one. They are the corpus's only account of
 * what earns a citation, so their absence is not a budget rounding error.
 */

const product = exampleluxeNormalizedProduct as unknown as PdpProductSignal;

function chunkOfKind(kind: PdpGeoRagKind, index: number): PdpGeoRetrievedChunk {
  return {
    id: `${kind}-${index}`,
    source: `${kind}_v1.md`,
    title: `${kind} section`,
    text: `Guidance text for the ${kind} family.`,
    kind,
    intents: ["general"],
    fieldTargets: ["Product.description"],
    metadata: {},
    // Deliberately lowest for the cards: a reserved slot must not depend on
    // score, which is the condition that hid the defect.
    score: kind === "evidence-cards" ? 0.01 : 0.9 - index * 0.01
  };
}

const reservedFamilies: PdpGeoRagKind[] = [
  "field-contracts",
  "best-practice",
  "geo-research",
  "evidence-cards",
  "cep",
  "eeat"
];

/** The ledger is empty on purpose: these assertions are about chunk selection. */
function requestWith(chunks: PdpGeoRetrievedChunk[]): PdpGeoContentPlanningRequest {
  return planningRequest(product, "en-US", { evidenceLedger: [], ragChunks: chunks });
}

describe("planning RAG family coverage", () => {
  it("seats every reserved policy family, including the evidence cards", () => {
    const chunks = reservedFamilies.map((kind, index) => chunkOfKind(kind, index));
    // The default planner budget is 5 — smaller than the reserved family count,
    // which is the condition under which the last family used to disappear.
    const prompt = createPlanningPrompt(requestWith(chunks), 10, 5);

    for (const kind of reservedFamilies) {
      expect(prompt.user, `family "${kind}" missing from taskGuidance`).toContain(`${kind}_v1.md`);
    }
  });

  it("still fills remaining budget by retrieval score once families are seated", () => {
    const chunks = [
      ...reservedFamilies.map((kind, index) => chunkOfKind(kind, index)),
      { ...chunkOfKind("schema", 0), id: "schema-high", source: "schema-high_v1.md", score: 0.99 },
      { ...chunkOfKind("locale", 0), id: "locale-low", source: "locale-low_v1.md", score: 0.02 }
    ];
    // Reserved families bypass the budget, so a budget of 7 leaves exactly one
    // discretionary slot for the two remaining chunks.
    const prompt = createPlanningPrompt(requestWith(chunks), 10, 7);

    expect(prompt.user).toContain("schema-high_v1.md");
    expect(prompt.user).not.toContain("locale-low_v1.md");
  });
});
