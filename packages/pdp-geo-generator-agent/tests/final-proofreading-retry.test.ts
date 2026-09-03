import { describe, expect, it } from "vitest";
import {
  createPdpGeoPublicCopyProvenance,
  finalProofreadPdpGeoArtifacts,
  type PdpGeoFinalProofreadingApplicationInput
} from "../src/final-proofreader";
import type { JsonObject, PdpGeoContentSections, PdpGeoFinalProofreadingRequest } from "../src/types";

/**
 * When a proposal fails an invariant gate the original text is kept, which is
 * safe but wastes the only attempt: the model never learns why it was refused
 * and the field stays in whatever shape the deterministic renderer left it. One
 * retry that carries the rejection reason back costs a single call and cannot
 * make the output worse — a second failure still keeps the original.
 */
const ANSWER = "Glow Serum is intended for dry skin skin.";

function applicationInput(): PdpGeoFinalProofreadingApplicationInput {
  const jsonLd: JsonObject = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        name: "Glow Serum",
        brand: { "@type": "Brand", name: "Glow Lab" },
        description: ANSWER
      }
    ]
  };
  const sections: PdpGeoContentSections = {
    productName: "Glow Serum",
    description: ANSWER,
    quickFacts: "Glow Serum quick facts.",
    benefits: "Moisturizing care.",
    ingredients: "Niacinamide.",
    howToUse: "",
    faq: ""
  };
  const evidenceLedger = [
    {
      id: "ev-description",
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
      description: ANSWER,
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
    content: { sections, html: `<div>${ANSWER}</div>` },
    evidenceLedger
  };
  input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
    schemaMarkup: input.schemaMarkup,
    evidenceLedger
  });
  return input;
}

function editsFor(request: PdpGeoFinalProofreadingRequest, revisedText: string) {
  return {
    edits: request.fields.map((field) => ({
      fieldPath: field.fieldPath,
      sourceHash: field.sourceHash,
      action: "revise" as const,
      revisedText,
      issueCodes: ["duplicate-word" as const]
    })),
    warnings: []
  };
}

describe("a rejected fluency proposal gets one constrained retry", () => {
  it("accepts a second proposal that satisfies the gate the first one failed", async () => {
    const input = applicationInput();
    const requests: PdpGeoFinalProofreadingRequest[] = [];
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          requests.push(request);
          // First attempt drops the product name, which is an immutable token.
          // Second attempt makes the duplicate-word repair that was intended.
          return requests.length === 1
            ? editsFor(request, "Glow Lab is intended for dry skin.")
            : editsFor(request, "Glow Serum is intended for dry skin.");
        }
      }
    });

    expect(requests).toHaveLength(2);
    expect(result.diagnostics.acceptedFields).toContain("Product.description");
    const product = (result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => node["@type"] === "Product") as JsonObject;
    expect(product.description).toBe("Glow Serum is intended for dry skin.");
  });

  it("carries the rejection reason back to the model on the retry", async () => {
    const input = applicationInput();
    const requests: PdpGeoFinalProofreadingRequest[] = [];
    await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          requests.push(request);
          return requests.length === 1
            ? editsFor(request, "Glow Lab is intended for dry skin.")
            : editsFor(request, "Glow Serum is intended for dry skin.");
        }
      }
    });

    expect(requests[0]?.fields[0]?.priorRejection).toBeUndefined();
    expect(requests[1]?.fields[0]?.priorRejection).toContain("Immutable token");
  });

  it("keeps the original and does not retry a third time when the retry also fails", async () => {
    const input = applicationInput();
    let calls = 0;
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          calls += 1;
          return editsFor(request, "Glow Lab is intended for dry skin.");
        }
      }
    });

    expect(calls).toBe(2);
    expect(result.diagnostics.acceptedFields).toEqual([]);
    const product = (result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => node["@type"] === "Product") as JsonObject;
    expect(product.description).toBe(ANSWER);
  });

  it("does not call again when the first attempt has nothing rejected", async () => {
    const input = applicationInput();
    let calls = 0;
    await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          calls += 1;
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

    expect(calls).toBe(1);
  });
});

/**
 * 편집 전에도 있던 finding이 편집 후에 "새로 생긴 이슈"로 세어지면, 교정 패스가
 * 모든 편집을 되돌리고 사실과 다른 사유를 보고한다.
 *
 * 열거 finding이 필드 전문을 담고 있었고, 그 finding이 붙는 필드(`.description`,
 * `acceptedAnswer.text`)는 하필 교정 패스가 편집하는 필드와 정확히 같다 — 열거가
 * 있는 상품에서는 교정이 구조적으로 무력화됐다.
 */
describe("이미 있던 finding은 새 이슈가 아니다", () => {
  const ENUMERATED = "글로우 세럼은 건조한 피부를 위한 세럼으로, 피부 장벽, 세정력, 저자극 저자극 세안을 돕습니다.";
  const REPAIRED = "글로우 세럼은 건조한 피부를 위한 세럼으로, 피부 장벽, 세정력, 저자극 세안을 돕습니다.";

  function koreanInput(): PdpGeoFinalProofreadingApplicationInput {
    const input = applicationInput();
    const graph = input.schemaMarkup.jsonLd["@graph"] as JsonObject[];
    const product = graph.find((node) => node["@type"] === "Product") as JsonObject;
    product.description = ENUMERATED;
    product.name = "글로우 세럼";
    input.content.sections.description = ENUMERATED;
    input.content.sections.productName = "글로우 세럼";
    input.content.html = `<div>${ENUMERATED}</div>`;
    input.product.name = "글로우 세럼";
    input.product.description = ENUMERATED;
    input.locale = "ko-KR";
    input.market = "KR";
    const evidenceLedger = [{
      id: "ev-description",
      role: "description" as const,
      text: ENUMERATED,
      sourcePath: "product.description",
      locale: "ko-KR" as const,
      productScope: "product" as const,
      confidence: 1
    }];
    input.evidenceLedger = evidenceLedger;
    input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: input.schemaMarkup,
      evidenceLedger
    });
    return input;
  }

  it("accepts a duplicate-word repair in a field that already enumerates", async () => {
    const result = await finalProofreadPdpGeoArtifacts(koreanInput(), {
      customFinalProofreader: {
        proofread(request) {
          return {
            edits: request.fields
              .filter((field) => field.fieldPath === "Product.description")
              .map((field) => ({
                fieldPath: field.fieldPath,
                sourceHash: field.sourceHash,
                action: "revise" as const,
                revisedText: REPAIRED,
                issueCodes: ["duplicate-word" as const]
              })),
            warnings: []
          };
        }
      }
    });

    expect(result.diagnostics.warnings ?? []).toHaveLength(0);
    console.log("DIAG2", JSON.stringify({s:result.diagnostics.status,a:result.diagnostics.acceptedFields,sk:result.diagnostics.skippedFields,w:result.diagnostics.warnings}));
    expect(result.diagnostics.acceptedFields).toContain("Product.description");
  });
});

/**
 * 필드 프로비넌스를 통째로 버리던 규칙을 없애고 문장 단위 보호로 옮겼다. 그
 * 보호가 실제로 편집을 막는지 확인한다 — 게이트 루프를 지워도 시험이 전부
 * 통과하던 상태였다(뮤테이션 검증).
 */
describe("근거 없는 문장은 재작성 대상이 아니다", () => {
  const BOUND = "Glow Serum is intended for dry skin.";
  const UNBOUND = "Reviewers described the texture as light.";
  const FIELD = `${BOUND} ${UNBOUND}`;

  function partiallyBoundInput(): PdpGeoFinalProofreadingApplicationInput {
    const input = applicationInput();
    const graph = input.schemaMarkup.jsonLd["@graph"] as JsonObject[];
    const product = graph.find((node) => node["@type"] === "Product") as JsonObject;
    product.description = FIELD;
    input.content.sections.description = FIELD;
    input.content.html = `<div>${FIELD}</div>`;
    input.product.description = FIELD;
    // 원장은 첫 문장만 뒷받침한다. 둘째 문장은 어떤 원자와도 맞지 않는다.
    const evidenceLedger = [{
      id: "ev-description",
      role: "description" as const,
      text: BOUND,
      sourcePath: "product.description",
      locale: "en-US" as const,
      productScope: "product" as const,
      confidence: 1
    }];
    input.evidenceLedger = evidenceLedger;
    input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: input.schemaMarkup,
      evidenceLedger
    });
    return input;
  }

  it("rejects an edit that rewords the sentence with no evidence binding", async () => {
    const result = await finalProofreadPdpGeoArtifacts(partiallyBoundInput(), {
      customFinalProofreader: {
        proofread(request) {
          return {
            edits: request.fields
              .filter((field) => field.fieldPath === "Product.description")
              .map((field) => ({
                fieldPath: field.fieldPath,
                sourceHash: field.sourceHash,
                action: "revise" as const,
                revisedText: `${BOUND} Reviewers called the texture lightweight.`,
                issueCodes: ["awkward" as const]
              })),
            warnings: []
          };
        }
      }
    });

    expect(result.diagnostics.acceptedFields).not.toContain("Product.description");
    expect(result.diagnostics.rejectedEdits?.[0]?.reason)
      .toContain("A sentence with no evidence binding was edited");
  });

});
