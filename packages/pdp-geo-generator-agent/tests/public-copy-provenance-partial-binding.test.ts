import { describe, expect, it } from "vitest";
import { createPdpGeoPublicCopyProvenance } from "../src/final-proofreader";
import type { JsonObject, PdpGeoAtomicEvidence, PdpGeoSchemaMarkup } from "../src/types";

/**
 * A field is published as one string but bound sentence by sentence. Before
 * this contract, one sentence that matched no ledger atom discarded the whole
 * field's provenance, and the final naturalisation pass then skipped the field
 * entirely — the measured effect was that 12 of 14 published fields never
 * reached that pass at all. Dropping the field is not the conservative
 * reading: it turns the feature off. The sentence that has no evidence is the
 * one that must not be edited; the rest of the field stays editable.
 */
function schemaMarkup(description: string): PdpGeoSchemaMarkup {
  const jsonLd: JsonObject = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        name: "Glow Serum",
        description
      }
    ]
  };
  return { jsonLd, scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` };
}

function evidence(
  overrides: Partial<PdpGeoAtomicEvidence> & Pick<PdpGeoAtomicEvidence, "id" | "text">
): PdpGeoAtomicEvidence {
  return {
    role: "description",
    sourcePath: "product.description",
    locale: "en-US",
    productScope: "product",
    confidence: 1,
    ...overrides
  };
}

const BOUND = "Glow Serum hydrates dry skin.";
const UNBOUND = "It layers well under sunscreen.";

describe("public copy provenance survives a partially bound field", () => {
  it("keeps the entry when one sentence matches no ledger atom", () => {
    const description = `${BOUND} ${UNBOUND}`;
    const entries = createPdpGeoPublicCopyProvenance({
      schemaMarkup: schemaMarkup(description),
      evidenceLedger: [evidence({ id: "ev-bound", text: BOUND })]
    });

    const entry = entries.find((item) => item.fieldPath === "Product.description");
    expect(entry).toBeDefined();
    expect(entry?.sentences).toHaveLength(2);
  });

  it("binds the supported sentence and leaves the unsupported one unbound", () => {
    const description = `${BOUND} ${UNBOUND}`;
    const entries = createPdpGeoPublicCopyProvenance({
      schemaMarkup: schemaMarkup(description),
      evidenceLedger: [evidence({ id: "ev-bound", text: BOUND })]
    });

    const entry = entries.find((item) => item.fieldPath === "Product.description");
    expect(entry?.sentences[0]?.evidenceIds).toEqual(["ev-bound"]);
    // An empty id list is what marks a sentence uneditable — the gate reads it
    // rather than a parallel flag, so the two can never disagree.
    expect(entry?.sentences[1]?.evidenceIds).toEqual([]);
  });

  it("still drops the field when no sentence has evidence at all", () => {
    const description = `${UNBOUND} It smells of nothing much.`;
    const entries = createPdpGeoPublicCopyProvenance({
      schemaMarkup: schemaMarkup(description),
      evidenceLedger: [evidence({ id: "ev-unrelated", text: "Packaged in a 30 ml amber bottle." })]
    });

    expect(entries.find((item) => item.fieldPath === "Product.description")).toBeUndefined();
  });
});
