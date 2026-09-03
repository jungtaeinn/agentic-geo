import { describe, expect, it } from "vitest";
import {
  createPdpGeoPublicCopyProvenance,
  finalProofreadPdpGeoArtifacts,
  type PdpGeoFinalProofreadingApplicationInput
} from "../src/final-proofreader";
import type { JsonObject, PdpGeoContentSections } from "../src/types";

/**
 * A FAQ item is two fields, and either one can be the one that fails to match a
 * ledger atom. Requiring both before either may be proofread means the weaker
 * half decides for the pair — the same all-or-nothing shape that kept whole
 * fields out of the pass. Each field carries its own binding, and the edit gate
 * already holds every substantive token, number, and speech act fixed, so a
 * reworded question cannot drift away from the answer it is paired with.
 */
// Lexically distant from every ledger atom, so the question stays unbound
// while the answer binds — the shape the live run produces, where answers bind
// far more often than questions do.
const QUESTION = "What should shoppers check before checkout?";
const ANSWER = "Glow Serum is intended for dry skin skin.";

function applicationInput(): PdpGeoFinalProofreadingApplicationInput {
  const jsonLd: JsonObject = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        name: "Glow Serum",
        brand: { "@type": "Brand", name: "Glow Lab" },
        description: "Glow Serum is a serum for dry skin."
      },
      {
        "@type": "FAQPage",
        mainEntity: [{
          "@type": "Question",
          name: QUESTION,
          acceptedAnswer: { "@type": "Answer", text: ANSWER }
        }]
      }
    ]
  };
  const sections: PdpGeoContentSections = {
    productName: "Glow Serum",
    description: "Glow Serum is a serum for dry skin.",
    quickFacts: "Glow Serum quick facts.",
    benefits: "Moisturizing care.",
    ingredients: "Niacinamide.",
    howToUse: "",
    faq: `Q. ${QUESTION}\nA. ${ANSWER}`
  };
  // Only the answer has a matching atom. Nothing in the ledger resembles the
  // question, so the question stays unbound while the answer is bound.
  const evidenceLedger = [
    {
      id: "ev-answer",
      role: "description" as const,
      text: ANSWER,
      sourcePath: "product.description",
      locale: "en-US" as const,
      productScope: "product" as const,
      confidence: 1
    }
  ];
  const input: PdpGeoFinalProofreadingApplicationInput = {
    product: {
      name: "Glow Serum",
      brand: "Glow Lab",
      description: "Glow Serum is a serum for dry skin.",
      category: "Serum",
      images: [],
      options: [],
      benefits: [],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: [],
      metrics: [],
      faq: [],
      reviews: { items: [], keywords: [] },
      breadcrumbs: [],
      sourceTexts: []
    },
    locale: "en-US",
    market: "US",
    schemaMarkup: {
      jsonLd,
      scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>`
    },
    content: { sections, html: "<div>Glow Serum is a serum for dry skin.</div>" },
    evidenceLedger
  };
  input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
    schemaMarkup: input.schemaMarkup,
    evidenceLedger
  });
  return input;
}

describe("a FAQ half that is bound is proofread even when its partner is not", () => {
  it("sends the bound answer instead of skipping the pair", async () => {
    const input = applicationInput();
    const sent: string[] = [];
    await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          sent.push(...request.fields.map((field) => field.fieldPath));
          return {
            edits: request.fields.map((field) => ({
              fieldPath: field.fieldPath,
              sourceHash: field.sourceHash,
              action: "keep" as const,
              revisedText: field.text,
              issueCodes: []
            })),
            warnings: []
          };
        }
      }
    });

    expect(sent).toContain("FAQPage.mainEntity[0].acceptedAnswer.text");
  });

  it("applies an accepted answer edit while the unbound question is left alone", async () => {
    const input = applicationInput();
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return {
            edits: request.fields.map((field) => {
              const isAnswer = field.fieldPath === "FAQPage.mainEntity[0].acceptedAnswer.text";
              return {
                fieldPath: field.fieldPath,
                sourceHash: field.sourceHash,
                action: isAnswer ? ("revise" as const) : ("keep" as const),
                // The doubled "skin skin" is a duplicate-word slip, which is
                // exactly the fluency-only repair this pass exists to make.
                revisedText: isAnswer ? "Glow Serum is intended for dry skin." : field.text,
                issueCodes: isAnswer ? (["duplicate-word"] as const).slice() : []
              };
            }),
            warnings: []
          };
        }
      }
    });

    expect(result.diagnostics.acceptedFields).toContain("FAQPage.mainEntity[0].acceptedAnswer.text");
    const faq = (result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => node["@type"] === "FAQPage") as JsonObject;
    const item = (faq.mainEntity as JsonObject[])[0] as JsonObject;
    expect((item.acceptedAnswer as JsonObject).text).toBe("Glow Serum is intended for dry skin.");
    expect(item.name).toBe(QUESTION);
  });
});
