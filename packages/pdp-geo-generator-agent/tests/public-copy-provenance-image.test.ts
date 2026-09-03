import { describe, expect, it } from "vitest";
import { createPdpGeoPublicCopyProvenance } from "../src/final-proofreader";
import type { JsonObject, PdpGeoAtomicEvidence, PdpGeoSchemaMarkup } from "../src/types";

const IMG_A = "https://cdn.example.com/a.png";
const IMG_B = "https://cdn.example.com/b.png";

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

describe("createPdpGeoPublicCopyProvenance image provenance", () => {
  it("exposes the union of cited atoms' imageUrls at entry and sentence level", () => {
    const description = "Glow Serum hydrates dry skin.";
    const evidenceLedger: PdpGeoAtomicEvidence[] = [
      evidence({ id: "ev-image", text: description, imageUrls: [IMG_A, IMG_B] })
    ];

    const entries = createPdpGeoPublicCopyProvenance({
      schemaMarkup: schemaMarkup(description),
      evidenceLedger
    });

    const entry = entries.find((item) => item.fieldPath === "Product.description");
    expect(entry?.imageUrls).toEqual([IMG_A, IMG_B]);
    expect(entry?.sentences[0]?.imageUrls).toEqual([IMG_A, IMG_B]);
  });

  it("omits imageUrls when only image-less atoms are cited", () => {
    const description = "Glow Serum hydrates dry skin.";
    const evidenceLedger: PdpGeoAtomicEvidence[] = [
      evidence({ id: "ev-text", text: description })
    ];

    const entries = createPdpGeoPublicCopyProvenance({
      schemaMarkup: schemaMarkup(description),
      evidenceLedger
    });

    const entry = entries.find((item) => item.fieldPath === "Product.description");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("imageUrls");
    expect(entry?.sentences[0]).not.toHaveProperty("imageUrls");
  });
});
