import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePdpGeo } from "../src/agent";
import {
  createPdpGeoPublicCopyProvenance,
  finalProofreadPdpGeoArtifacts,
  ModelBackedFinalProofreader,
  type PdpGeoFinalProofreadingApplicationInput
} from "../src/final-proofreader";
import { validatePdpGeoArtifacts } from "../src/validate";
import type {
  JsonObject,
  PdpGeoContentSections,
  PdpGeoContentPlan,
  PdpGeoFinalProofreadingRequest,
  PdpGeoFinalProofreadingResult
} from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalProofreadPdpGeoArtifacts", () => {
  it("is library opt-in and honors an explicit disable even when a custom proofreader exists", async () => {
    const input = applicationInput();
    let calls = 0;
    const disabled = await finalProofreadPdpGeoArtifacts(input, {
      finalProofreading: { enabled: false },
      customFinalProofreader: {
        proofread(request) {
          calls += 1;
          return responseFor(request, (field) => field.text);
        }
      }
    });
    const unconfigured = await finalProofreadPdpGeoArtifacts(input, {});

    expect(calls).toBe(0);
    expect(disabled.diagnostics.called).toBe(false);
    expect(unconfigured.diagnostics.called).toBe(false);
    expect(disabled.schemaMarkup).toBe(input.schemaMarkup);
    expect(unconfigured.content).toBe(input.content);
  });

  it("accepts only fluency edits and synchronizes schema, visible sections, HTML, and scriptTag", async () => {
    const input = applicationInput();
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => {
            switch (field.fieldPath) {
              case "Product.description":
                return "Glow Serum is a serum for dry skin.";
              case "WebPage.description":
                return "This official product page presents Glow Serum.";
              case "FAQPage.mainEntity[0].name":
                return "Is Glow Serum suitable for dry skin?";
              case "FAQPage.mainEntity[0].acceptedAnswer.text":
                return "Glow Serum is intended for dry skin.";
              case "HowTo.step[0].text":
                return "Apply Glow Serum to clean skin.";
              default:
                return field.text;
            }
          });
        }
      }
    });

    expect(result.diagnostics.called).toBe(true);
    expect(result.diagnostics.applied).toBe(true);
    expect(result.diagnostics.rejectedEdits).toEqual([]);
    expect(result.diagnostics.acceptedEdits[0]).toMatchObject({
      fieldPath: "Product.description",
      before: "Glow Serum is a serum for dry skin. Glow Serum is a serum for dry skin.",
      after: "Glow Serum is a serum for dry skin.",
      evidenceIds: ["ev-product-description"]
    });
    expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description).toBe("Glow Serum is a serum for dry skin.");
    expect(readNode(result.schemaMarkup.jsonLd, "WebPage")?.description).toBe("This official product page presents Glow Serum.");
    expect(result.content.sections.description).toBe("Glow Serum is a serum for dry skin.");
    expect(result.content.sections.faq).toContain("Q. Is Glow Serum suitable for dry skin?");
    expect(result.content.sections.faq).toContain("A. Glow Serum is intended for dry skin.");
    expect(result.content.sections.howToUse).toBe("1. Apply Glow Serum to clean skin.");
    expect(result.content.html).toContain("Glow Serum is a serum for dry skin.");
    expect(JSON.parse(result.schemaMarkup.scriptTag.match(/>([\s\S]*)<\/script>/)?.[1] ?? "")).toEqual(result.schemaMarkup.jsonLd);
    const finalTrace = result.finalPublicCopyProvenance.find((item) => item.fieldPath === "Product.description");
    expect(finalTrace).toMatchObject({
      text: "Glow Serum is a serum for dry skin.",
      evidenceIds: ["ev-product-description"]
    });
    expect(finalTrace?.sourceHash).not.toBe(result.diagnostics.acceptedEdits[0]?.sourceHash);
  });

  it("rejects fact, number, and claim-modality changes while keeping the original field", async () => {
    const input = applicationInput({
      productDescription: "Glow Serum may help moisture in a reported test of 93%."
    });
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum improves moisture in a proven test of 95%."
            : field.text);
        }
      }
    });

    expect(result.diagnostics.applied).toBe(false);
    expect(result.diagnostics.rejectedEdits[0]?.fieldPath).toBe("Product.description");
    expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description)
      .toBe("Glow Serum may help moisture in a reported test of 93%.");
  });

  it("accepts a Korean duplicate-sentence cleanup without translating or expanding the claim", async () => {
    const input = applicationInput();
    const description = "글로우 세럼은 건조한 피부를 위한 세럼입니다. 글로우 세럼은 건조한 피부를 위한 세럼입니다.";
    input.locale = "ko-KR";
    input.product.name = "글로우 세럼";
    input.content.sections.productName = "글로우 세럼";
    input.content.sections.description = description;
    const product = readNode(input.schemaMarkup.jsonLd, "Product");
    if (product) product.description = description;
    input.evidenceLedger = [evidence("ev-product-description-ko", "description", description, "product.description")];
    input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: input.schemaMarkup,
      evidenceLedger: input.evidenceLedger
    });

    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "글로우 세럼은 건조한 피부를 위한 세럼입니다."
            : field.text);
        }
      }
    });

    expect(result.diagnostics.acceptedFields).toContain("Product.description");
    expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description)
      .toBe("글로우 세럼은 건조한 피부를 위한 세럼입니다.");
  });

  it("accepts only closed-list English agreement and Korean same-role particle corrections", async () => {
    const english = applicationInput({ productDescription: "Glow Serum are an serum for dry skin." });
    const englishResult = await finalProofreadPdpGeoArtifacts(english, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum is a serum for dry skin."
            : field.text);
        }
      }
    });
    expect(englishResult.diagnostics.acceptedFields).toContain("Product.description");

    const korean = applicationInput({ productDescription: "글로우 세럼는 건조한 피부용 세럼입니다." });
    korean.locale = "ko-KR";
    korean.product.name = "글로우 세럼";
    korean.content.sections.productName = "글로우 세럼";
    korean.evidenceLedger = [evidence("ev-ko-grammar", "description", korean.content.sections.description, "product.description")];
    korean.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: korean.schemaMarkup,
      evidenceLedger: korean.evidenceLedger
    });
    const koreanResult = await finalProofreadPdpGeoArtifacts(korean, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "글로우 세럼은 건조한 피부용 세럼입니다."
            : field.text);
        }
      }
    });
    expect(koreanResult.diagnostics.acceptedFields).toContain("Product.description");
  });

  it("rejects reverse-direction agreement, FAQ inversion, and Korean style regressions", async () => {
    const cases: Array<{ original: string; proposed: string; locale?: "ko-KR" }> = [
      { original: "Glow Serum is suitable for dry skin.", proposed: "Glow Serum are suitable for dry skin." },
      { original: "Glow Serum contains Niacinamide.", proposed: "Glow Serum contain Niacinamide." },
      { original: "The product and formula are suitable.", proposed: "The product and formula is suitable." },
      { original: "The ingredients in the formula are listed.", proposed: "The ingredients in the formula is listed." },
      { original: "A is the active vitamin in this formula.", proposed: "An is the active vitamin in this formula." },
      { original: "A essence contains Retinol.", proposed: "An essence contains Retinol." },
      { original: "아모은 기술이 보습을 지원합니다.", proposed: "아모는 기술이 보습을 지원합니다.", locale: "ko-KR" },
      { original: "글로우 세럼입니다.", proposed: "글로우 세럼이다.", locale: "ko-KR" }
    ];
    for (const item of cases) {
      const input = applicationInput({ productDescription: item.original });
      if (item.locale) {
        input.locale = item.locale;
        input.product.name = "글로우 세럼";
        input.content.sections.productName = "글로우 세럼";
      }
      input.evidenceLedger = [evidence("ev-direction", "description", item.original, "product.description")];
      input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
        schemaMarkup: input.schemaMarkup,
        evidenceLedger: input.evidenceLedger
      });
      const result = await finalProofreadPdpGeoArtifacts(input, {
        customFinalProofreader: {
          proofread(request) {
            return responseFor(request, (field) => field.fieldPath === "Product.description" ? item.proposed : field.text);
          }
        }
      });
      expect(result.diagnostics.acceptedFields, `${item.original} -> ${item.proposed}`).not.toContain("Product.description");
    }
  });

  it("preserves terminal speech acts and rejects bidi, zero-width, and control characters", async () => {
    const proposals = [
      "Glow Serum improves redness?",
      "Glow Serum \u202eimproves redness\u202c.",
      "Glow Serum im\u200bproves redness.",
      "Glow Serum improves\nredness.",
      "Glow Serum improves redness\u0336.",
      "Glow Serum improves redness\u20e0.",
      "Glow Serum improves redness\ufe0f.",
      "Glow Serum improves redness 🚫.",
      "Glow Serum improves redness\u034f."
    ];
    for (const proposal of proposals) {
      const input = applicationInput({ productDescription: "Glow Serum improves redness." });
      const result = await finalProofreadPdpGeoArtifacts(input, {
        customFinalProofreader: {
          proofread(request) {
            return responseFor(request, (field) => field.fieldPath === "Product.description" ? proposal : field.text);
          }
        }
      });
      expect(result.diagnostics.acceptedFields, proposal).not.toContain("Product.description");
      expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description).toBe("Glow Serum improves redness.");
    }
  });

  it("rejects quote-boundary and comma-scope changes that alter attribution or negation", async () => {
    const cases = [
      [
        "One customer review said: “The finish felt light. Glow Serum improves redness”.",
        "One customer review said: “The finish felt light”. Glow Serum improves redness."
      ],
      ["No Glow Serum improves redness.", "No, Glow Serum improves redness."]
    ] as const;
    for (const [original, proposed] of cases) {
      const input = applicationInput({ productDescription: original });
      const result = await finalProofreadPdpGeoArtifacts(input, {
        customFinalProofreader: {
          proofread(request) {
            return responseFor(request, (field) => field.fieldPath === "Product.description" ? proposed : field.text);
          }
        }
      });
      expect(result.diagnostics.acceptedFields).not.toContain("Product.description");
      expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description).toBe(original);
    }
  });

  it("allows FAQ auxiliary inversion but keeps HowTo as an action rather than a question", async () => {
    const input = applicationInput();
    const faq = readNode(input.schemaMarkup.jsonLd, "FAQPage");
    const question = Array.isArray(faq?.mainEntity) ? faq.mainEntity[0] : undefined;
    if (question && typeof question === "object") question.name = "Glow Serum is suitable for dry skin?";
    input.content.sections.faq = "Q. Glow Serum is suitable for dry skin?\nA. Glow Serum is intended for dry skin skin.";
    input.evidenceLedger = [
      evidence("ev-faq-inversion", "faq", "Glow Serum is suitable for dry skin?\nGlow Serum is intended for dry skin skin.", "product.faq[0]"),
      evidence("ev-usage", "usage", "Apply Glow Serum to clean skin", "product.usage[0]")
    ];
    input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: input.schemaMarkup,
      evidenceLedger: input.evidenceLedger
    });
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => {
            if (field.fieldPath.endsWith(".name")) return "Is Glow Serum suitable for dry skin?";
            if (field.fieldPath.startsWith("HowTo.")) return "Apply Glow Serum to clean skin?";
            return field.text;
          });
        }
      }
    });
    expect(result.diagnostics.acceptedFields).toContain("FAQPage.mainEntity[0].name");
    expect(result.diagnostics.acceptedFields).not.toContain("HowTo.step[0].text");
    expect(readNode(result.schemaMarkup.jsonLd, "HowTo")?.step?.[0]?.text).toBe("Apply Glow Serum to clean skin");
  });

  it("records valid evidence IDs and rejects edits when finalized model-plan copy lost its exact binding", async () => {
    const input = applicationInput();
    input.evidenceLedger = [{
      id: "ev-product",
      role: "description",
      text: input.content.sections.description,
      sourcePath: "product.description",
      locale: "en-US",
      productScope: "product",
      confidence: 1
    }];
    input.contentPlan = modelPlan(input.content.sections.description);
    input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: input.schemaMarkup,
      contentPlan: input.contentPlan,
      evidenceLedger: input.evidenceLedger
    });
    const accepted = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum is a serum for dry skin."
            : field.text);
        }
      }
    });
    expect(accepted.diagnostics.acceptedEdits.find((item) => item.fieldPath === "Product.description")?.evidenceIds)
      .toEqual(["ev-product"]);

    const staleInput = applicationInput();
    staleInput.evidenceLedger = input.evidenceLedger;
    staleInput.contentPlan = modelPlan(staleInput.content.sections.description);
    staleInput.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: staleInput.schemaMarkup,
      contentPlan: staleInput.contentPlan,
      evidenceLedger: staleInput.evidenceLedger
    }).map((item) => ({ ...item, sourceHash: "fnv1a-stale" }));
    const rejected = await finalProofreadPdpGeoArtifacts(staleInput, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum is a serum for dry skin."
            : field.text);
        }
      }
    });
    expect(rejected.diagnostics.acceptedFields).not.toContain("Product.description");
    expect(rejected.diagnostics.called).toBe(false);
    expect(rejected.diagnostics.warnings.some((item) => item.includes("no eligible public-copy fields"))).toBe(true);
  });

  it("rejects review-scope generalization and a newly connected ingredient-benefit relation", async () => {
    const reviewInput = applicationInput({
      productDescription: "한 고객 리뷰에서는 Glow Serum의 마무리가 가볍다고 언급했습니다."
    });
    const reviewResult = await finalProofreadPdpGeoArtifacts(reviewInput, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "고객 리뷰에서는 Glow Serum의 마무리가 가볍다고 평가했습니다."
            : field.text);
        }
      }
    });
    expect(reviewResult.diagnostics.rejectedEdits[0]?.reason).toMatch(/review/i);

    const relationInput = applicationInput({
      productDescription: "Glow Serum contains Niacinamide. The product supports hydration."
    });
    const relationResult = await finalProofreadPdpGeoArtifacts(relationInput, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum contains Niacinamide, which supports hydration."
            : field.text);
        }
      }
    });
    expect(relationResult.diagnostics.rejectedEdits[0]?.reason).toMatch(/ingredient-to-benefit|causal/i);
  });

  it("rejects high-similarity swaps of concerns, benefits, technologies, timing, and modality", async () => {
    const cases = [
      ["Glow Serum is intended for dry skin.", "Glow Serum is intended for oily skin."],
      ["Glow Serum supports hydration.", "Glow Serum supports brightening."],
      ["Glow Serum contains HydraTech.", "Glow Serum contains BrightTech."],
      ["Glow Serum is used in the morning.", "Glow Serum is used at night."],
      ["Glow Serum may help reduce redness.", "Glow Serum can improve redness."],
      ["Niacinamide supports hydration.", "Hydration supports Niacinamide."],
      ["Glow Serum was tested on 30 women.", "Glow Serum is tested on 30 women."],
      ["Glow Serum was tested by 30 women.", "Glow Serum was tested for 30 women."],
      ["A customer review described Glow Serum as lightweight.", "Customer reviews described Glow Serum as lightweight."],
      ["Glow Serum은 밤 루틴에 적합한 세럼입니다.", "Glow Serum은 낮 루틴에 적합한 세럼입니다."],
      [
        "Niacinamide supports hydration, and hydration supports barrier health in Glow Serum.",
        "Niacinamide supports hydration and supports barrier health in Glow Serum."
      ],
      [
        "Glow Serum hydration was 10%. Redness was 20%. Elasticity was 10%.",
        "Glow Serum hydration was 10%. Redness was 10%. Elasticity was 20%."
      ]
    ] as const;

    for (const [original, proposed] of cases) {
      const input = applicationInput({ productDescription: original });
      const result = await finalProofreadPdpGeoArtifacts(input, {
        customFinalProofreader: {
          proofread(request) {
            return responseFor(request, (field) => field.fieldPath === "Product.description" ? proposed : field.text);
          }
        }
      });
      expect(result.diagnostics.applied, `${original} -> ${proposed}`).toBe(false);
      expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description).toBe(original);
    }
  });

  it("allows removing an exactly duplicated metric sentence but not a distinct factual sentence", async () => {
    const duplicate = "A reported Glow Serum test shows 93% satisfaction. A reported Glow Serum test shows 93% satisfaction.";
    const duplicateInput = applicationInput({ productDescription: duplicate });
    const duplicateResult = await finalProofreadPdpGeoArtifacts(duplicateInput, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "A reported Glow Serum test shows 93% satisfaction."
            : field.text);
        }
      }
    });
    expect(duplicateResult.diagnostics.acceptedFields).toContain("Product.description");

    const distinct = "Glow Serum is intended for dry skin. Glow Serum contains Niacinamide.";
    const distinctInput = applicationInput({ productDescription: distinct });
    const distinctResult = await finalProofreadPdpGeoArtifacts(distinctInput, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum is intended for dry skin."
            : field.text);
        }
      }
    });
    expect(distinctResult.diagnostics.applied).toBe(false);
    expect(readNode(distinctResult.schemaMarkup.jsonLd, "Product")?.description).toBe(distinct);
  });

  it("reverts an FAQ pair atomically and restricts HowTo to punctuation-only edits", async () => {
    const input = applicationInput();
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => {
            if (field.fieldPath === "FAQPage.mainEntity[0].name") return "Is Glow Serum suitable for dry skin?";
            if (field.fieldPath === "FAQPage.mainEntity[0].acceptedAnswer.text") return "Glow Serum is proven to improve dry skin by 95%.";
            if (field.fieldPath === "HowTo.step[0].text") return "Apply Glow Serum to damp skin.";
            return field.text;
          });
        }
      }
    });
    const faq = readNode(result.schemaMarkup.jsonLd, "FAQPage");
    const faqItem = Array.isArray(faq?.mainEntity) ? faq.mainEntity[0] as Record<string, any> : undefined;
    const howTo = readNode(result.schemaMarkup.jsonLd, "HowTo");
    const step = Array.isArray(howTo?.step) ? howTo.step[0] as Record<string, any> : undefined;

    expect(faqItem?.name).toBe("Is Glow Serum suitable for dry skin??");
    expect(faqItem?.acceptedAnswer?.text).toBe("Glow Serum is intended for dry skin skin.");
    expect(step?.text).toBe("Apply Glow Serum to clean skin");
    expect(result.diagnostics.rejectedEdits.map((item) => item.fieldPath))
      .toEqual(expect.arrayContaining([
        "FAQPage.mainEntity[0].name",
        "FAQPage.mainEntity[0].acceptedAnswer.text",
        "HowTo.step[0].text"
      ]));
  });

  it("excludes an FAQ pair from the model request when either side lacks exact provenance", async () => {
    const input = applicationInput();
    input.publicCopyProvenance = input.publicCopyProvenance?.filter((item) => !item.fieldPath.endsWith("acceptedAnswer.text"));
    let requestedPaths: string[] = [];
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          requestedPaths = request.fields.map((field) => field.fieldPath);
          return responseFor(request, (field) => field.text);
        }
      }
    });

    expect(requestedPaths.some((path) => path.startsWith("FAQPage."))).toBe(false);
    expect(result.diagnostics.skippedFields.filter((item) => item.fieldPath.startsWith("FAQPage."))).toHaveLength(2);
    expect(result.diagnostics.warnings.some((item) => item.includes("FAQPage.mainEntity[0]"))).toBe(true);
  });

  it("does not create provenance from an unrelated keyword or a partial model-plan citation", async () => {
    const keywordOnly = applicationInput({ productDescription: "Glow Serum improves redness." });
    keywordOnly.evidenceLedger = [evidence("ev-redness-word", "source", "redness", "product.sourceTexts[0]")];
    keywordOnly.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: keywordOnly.schemaMarkup,
      evidenceLedger: keywordOnly.evidenceLedger
    });
    expect(keywordOnly.publicCopyProvenance.some((item) => item.fieldPath === "Product.description")).toBe(false);
    const skipped = await finalProofreadPdpGeoArtifacts(keywordOnly, {
      customFinalProofreader: { proofread: (request) => responseFor(request, (field) => field.text) }
    });
    expect(skipped.diagnostics.skippedFields.some((item) => item.fieldPath === "Product.description")).toBe(true);

    for (const [role, text] of [
      ["source", "Tests do not show that Glow Serum improves redness."],
      ["description", "Preliminary evidence suggests that Glow Serum improves redness."],
      ["source", "Glow Serum improves redness in vitro, not in people."],
      ["review", "One customer review says Glow Serum improves redness."]
    ] as const) {
      const scoped = applicationInput({ productDescription: "Glow Serum improves redness." });
      scoped.evidenceLedger = [{
        ...evidence("ev-scoped", role === "review" ? "source" : role, text, `product.${role}`),
        role
      }];
      scoped.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
        schemaMarkup: scoped.schemaMarkup,
        evidenceLedger: scoped.evidenceLedger
      });
      expect(scoped.publicCopyProvenance.some((item) => item.fieldPath === "Product.description"), text).toBe(false);
    }

    const multiSentence = applicationInput({
      productDescription: "Glow Serum is for dry skin. Glow Serum contains Niacinamide. Glow Serum improves redness."
    });
    multiSentence.evidenceLedger = [{
      id: "ev-ingredient-only",
      role: "ingredient",
      text: "Niacinamide",
      sourcePath: "product.ingredients[0]",
      locale: "en-US",
      productScope: "product",
      confidence: 1
    }];
    multiSentence.contentPlan = modelPlan(multiSentence.content.sections.description);
    multiSentence.contentPlan.productDescription.evidenceIds = ["ev-ingredient-only"];
    multiSentence.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: multiSentence.schemaMarkup,
      contentPlan: multiSentence.contentPlan,
      evidenceLedger: multiSentence.evidenceLedger
    });
    expect(multiSentence.publicCopyProvenance.some((item) => item.fieldPath === "Product.description")).toBe(false);

    const causalJoin = applicationInput({ productDescription: "Niacinamide improves redness." });
    causalJoin.evidenceLedger = [
      { ...evidence("ev-niacinamide", "source", "Niacinamide", "product.ingredients[0]"), role: "ingredient" },
      { ...evidence("ev-redness-effect", "source", "improves redness", "product.effects[0]"), role: "effect" }
    ];
    causalJoin.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: causalJoin.schemaMarkup,
      evidenceLedger: causalJoin.evidenceLedger
    });
    expect(causalJoin.publicCopyProvenance.some((item) => item.fieldPath === "Product.description")).toBe(false);

    const brandJoin = applicationInput({ productDescription: "Glow Lab improves redness." });
    brandJoin.evidenceLedger = [
      { ...evidence("ev-brand", "source", "Glow Lab", "product.brand"), role: "identity" },
      { ...evidence("ev-brand-effect", "source", "improves redness", "product.effects[0]"), role: "effect" }
    ];
    brandJoin.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: brandJoin.schemaMarkup,
      evidenceLedger: brandJoin.evidenceLedger
    });
    expect(brandJoin.publicCopyProvenance.some((item) => item.fieldPath === "Product.description")).toBe(false);

    const metricJoin = applicationInput({ productDescription: "Hydration improved 10% in 30 users." });
    metricJoin.evidenceLedger = [
      { ...evidence("ev-metric-value", "source", "Hydration improved 10%", "product.metrics[0]"), role: "metric" },
      { ...evidence("ev-metric-sample", "source", "30 users", "product.metrics[1]"), role: "metric" }
    ];
    metricJoin.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
      schemaMarkup: metricJoin.schemaMarkup,
      evidenceLedger: metricJoin.evidenceLedger
    });
    expect(metricJoin.publicCopyProvenance.some((item) => item.fieldPath === "Product.description")).toBe(false);
  });

  it("rejects the whole response when a field is missing or reordered", async () => {
    const input = applicationInput();
    const before = JSON.parse(JSON.stringify(input));
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          const complete = responseFor(request, (field) => field.text);
          return { ...complete, edits: complete.edits.slice(1) };
        }
      }
    });

    expect(result.diagnostics.called).toBe(true);
    expect(result.diagnostics.applied).toBe(false);
    expect(result.diagnostics.rejectedEdits[0]?.reason).toContain("entire response was discarded");
    expect(result.schemaMarkup).toEqual(before.schemaMarkup);
    expect(result.content).toEqual(before.content);
  });

  it("rejects the whole response on actual reordering or a stale sourceHash", async () => {
    for (const mutate of [
      (result: PdpGeoFinalProofreadingResult) => ({ ...result, edits: [...result.edits].reverse() }),
      (result: PdpGeoFinalProofreadingResult) => ({
        ...result,
        edits: result.edits.map((edit, index) => index === 0 ? { ...edit, sourceHash: "stale-hash" } : edit)
      })
    ]) {
      const input = applicationInput();
      const result = await finalProofreadPdpGeoArtifacts(input, {
        customFinalProofreader: {
          proofread(request) {
            return mutate(responseFor(request, (field) => field.text));
          }
        }
      });
      expect(result.diagnostics.applied).toBe(false);
      expect(result.diagnostics.rejectedEdits[0]?.reason).toMatch(/path\/order\/source hash mismatch/i);
      expect(result.schemaMarkup).toBe(input.schemaMarkup);
    }
  });

  it("fails closed and preserves byte-equivalent artifacts when the provider throws", async () => {
    const input = applicationInput();
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread() {
          throw new Error("provider unavailable");
        }
      }
    });

    expect(result.diagnostics.called).toBe(true);
    expect(result.diagnostics.applied).toBe(false);
    expect(result.schemaMarkup).toBe(input.schemaMarkup);
    expect(result.content).toBe(input.content);
  });

  it("does not inherit credentials or deployment settings when the final provider changes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = applicationInput();
    const result = await finalProofreadPdpGeoArtifacts(input, {
      provider: "azure-openai",
      apiKey: "azure-secret",
      endpoint: "https://trusted.openai.azure.com",
      deployment: "azure-reasoning",
      finalProofreading: {
        enabled: true,
        provider: "gemini",
        model: "gemini-test"
      }
    });

    expect(result.diagnostics.status).toBe("failed");
    expect(result.diagnostics.warnings.join(" ")).toMatch(/Gemini API key and model are required/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rolls back otherwise surface-only edits when they introduce a new validation finding", async () => {
    const original = "Glow Serum is intended for dry skin.";
    const input = applicationInput({ productDescription: original });
    const result = await finalProofreadPdpGeoArtifacts(input, {
      customFinalProofreader: {
        proofread(request) {
          return responseFor(request, (field) => field.fieldPath === "Product.description"
            ? "Glow Serum is intended for dry skin..."
            : field.text);
        }
      }
    });

    expect(result.diagnostics.applied).toBe(false);
    expect(result.diagnostics.rejectedEdits.some((item) => item.reason.includes("read-only validation"))).toBe(true);
    expect(readNode(result.schemaMarkup.jsonLd, "Product")?.description).toBe(original);
  });

  it("uses Azure strict Structured Outputs for the independent proofreading call", async () => {
    let requestBody: Record<string, any> | undefined;
    let requestUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      const field = proofreaderRequest().fields[0]!;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          edits: [{
            fieldPath: field.fieldPath,
            sourceHash: field.sourceHash,
            action: "keep",
            revisedText: field.text,
            issueCodes: []
          }],
          warnings: []
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const proofreader = new ModelBackedFinalProofreader({
      provider: "azure-openai",
      apiKey: "test-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt/5.5",
      apiVersion: "2025-04-01-preview"
    });
    const result = await proofreader.proofread(proofreaderRequest());

    expect(requestBody?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pdp_geo_final_proofreading", strict: true }
    });
    expect(requestBody?.response_format?.json_schema?.schema?.additionalProperties).toBe(false);
    expect(requestUrl).toContain("/deployments/gpt%2F5.5/chat/completions");
    expect(result.usage?.totalTokens).toBe(12);
  });

  it("URL-encodes Gemini model path segments", async () => {
    let requestUrl = "";
    const field = proofreaderRequest().fields[0]!;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          edits: [{ fieldPath: field.fieldPath, sourceHash: field.sourceHash, action: "keep", revisedText: field.text, issueCodes: [] }],
          warnings: []
        }) }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const proofreader = new ModelBackedFinalProofreader({
      provider: "gemini",
      apiKey: "test-key",
      model: "gemini/test"
    });

    await proofreader.proofread(proofreaderRequest());
    expect(requestUrl).toContain("/models/gemini%2Ftest:generateContent");
  });
});

describe("read-only final validation", () => {
  it("reports repair candidates without mutating nested schema or public content", () => {
    const input = applicationInput();
    const howTo = readNode(input.schemaMarkup.jsonLd, "HowTo");
    const step = Array.isArray(howTo?.step) ? howTo.step[0] as Record<string, unknown> : undefined;
    if (step) {
      step.position = 9;
      step.name = "Original source label";
    }
    input.schemaMarkup.scriptTag = "<script type=\"application/ld+json\">{}</script>";
    const snapshot = JSON.parse(JSON.stringify(input));

    const validation = validatePdpGeoArtifacts({
      schemaMarkup: input.schemaMarkup,
      content: input.content,
      fallbackProductName: input.content.sections.productName,
      fallbackDescription: input.content.sections.description,
      locale: input.locale
    });

    expect(input).toEqual(snapshot);
    expect(validation.validationFindings.some((item) => item.field === "schemaMarkup.scriptTag")).toBe(true);
    expect(validation.validationFindings.filter((item) => item.field !== "schemaMarkup.scriptTag")
      .every((item) => item.suggestedAction.startsWith("Not applied; suggested only:"))).toBe(true);
    expect(validation.validationWarnings.join(" ")).not.toMatch(/\b(?:was|were)\s+(?:repaired|removed|rebuilt|sanitized)\b/i);
    expect(step?.position).toBe(9);
    expect(step?.name).toBe("Original source label");
  });
});

describe("generator final proofreading integration", () => {
  it("calls proofreading after content generation and records its token usage separately", async () => {
    let seenFields = 0;
    const run = await generatePdpGeo({
      product: {
        name: "Glow Serum",
        brand: "Glow Lab",
        description: "A moisturizing serum for dry skin.",
        ingredients: ["Niacinamide"],
        usage: ["Apply Glow Serum to clean skin."]
      },
      hints: { locale: "en-US", market: "US", schemaTargets: ["WebPage", "Product", "FAQPage", "HowTo"] }
    }, {
      customFinalProofreader: {
        proofread(request) {
          seenFields = request.fields.length;
          return { ...responseFor(request, (field) => field.text), usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } };
        }
      }
    });

    expect(seenFields).toBeGreaterThan(0);
    expect(run.result.diagnostics.finalProofreading).toMatchObject({ called: true, applied: false });
    expect(run.result.diagnostics.runtimeUsage?.steps.find((step) => step.label === "Final proofreading"))
      .toMatchObject({ called: true, tokenUsage: { totalTokens: 11 } });
    expect(run.result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(11);
    expect(run.result.diagnostics.validationRepairs).toEqual([]);
  });
});

function responseFor(
  request: PdpGeoFinalProofreadingRequest,
  revise: (field: PdpGeoFinalProofreadingRequest["fields"][number]) => string
): PdpGeoFinalProofreadingResult {
  return {
    edits: request.fields.map((field) => {
      const revisedText = revise(field);
      return {
        fieldPath: field.fieldPath,
        sourceHash: field.sourceHash,
        action: revisedText === field.text ? "keep" as const : "revise" as const,
        revisedText,
        issueCodes: revisedText === field.text ? [] : testIssueCodes(field.text, revisedText)
      };
    }),
    warnings: []
  };
}

function testIssueCodes(original: string, revised: string): Array<"grammar" | "duplicate-sentence" | "duplicate-word" | "punctuation"> {
  const sentences = original.split(/(?<=[.!?。！？])\s+/u);
  if (sentences.some((sentence, index) => index > 0 && sentence === sentences[index - 1])
    && revised.split(/(?<=[.!?。！？])\s+/u).length < sentences.length) {
    return ["duplicate-sentence"];
  }
  const words = original.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.some((word, index) => index > 0 && word === words[index - 1])
    && (revised.match(/[\p{L}\p{N}]+/gu) ?? []).length < words.length) {
    return ["duplicate-word"];
  }
  const strip = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");
  return strip(original) === strip(revised) ? ["punctuation"] : ["grammar"];
}

function proofreaderRequest(): PdpGeoFinalProofreadingRequest {
  return {
    locale: "en-US",
    market: "US",
    productName: "Glow Serum",
    brand: "Glow Lab",
    fields: [{
      fieldPath: "Product.description",
      sourceHash: "fnv1a-test",
      text: "Glow Serum is a serum for dry skin.",
      constraint: "fluency-only",
      evidenceIds: ["ev-1"],
      immutableTokens: ["Glow Serum"]
    }],
    evidenceLedger: []
  };
}

function applicationInput(overrides: { productDescription?: string } = {}): PdpGeoFinalProofreadingApplicationInput {
  const productDescription = overrides.productDescription
    ?? "Glow Serum is a serum for dry skin. Glow Serum is a serum for dry skin.";
  const jsonLd: JsonObject = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        description: "This official product page presents Glow Serum. This official product page presents Glow Serum."
      },
      {
        "@type": "Product",
        name: "Glow Serum",
        brand: { "@type": "Brand", name: "Glow Lab" },
        description: productDescription
      },
      {
        "@type": "FAQPage",
        mainEntity: [{
          "@type": "Question",
          name: "Is Glow Serum suitable for dry skin??",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Glow Serum is intended for dry skin skin."
          }
        }]
      },
      {
        "@type": "HowTo",
        name: "How to use Glow Serum",
        step: [{
          "@type": "HowToStep",
          position: 1,
          name: "Step 1",
          text: "Apply Glow Serum to clean skin"
        }]
      }
    ]
  };
  const sections: PdpGeoContentSections = {
    productName: "Glow Serum",
    description: productDescription,
    quickFacts: "Glow Serum quick facts.",
    benefits: "Moisturizing care.",
    ingredients: "Niacinamide.",
    howToUse: "1. Apply Glow Serum to clean skin",
    faq: "Q. Is Glow Serum suitable for dry skin??\nA. Glow Serum is intended for dry skin skin."
  };
  const evidenceLedger = [
    evidence("ev-product-description", "description", productDescription, "product.description"),
    evidence("ev-webpage-description", "source", "This official product page presents Glow Serum. This official product page presents Glow Serum.", "product.sourceTexts[0]"),
    evidence("ev-faq", "faq", "Is Glow Serum suitable for dry skin??\nGlow Serum is intended for dry skin skin.", "product.faq[0]"),
    evidence("ev-usage", "usage", "Apply Glow Serum to clean skin", "product.usage[0]")
  ];
  const input: PdpGeoFinalProofreadingApplicationInput = {
    product: {
      name: "Glow Serum",
      brand: "Glow Lab",
      description: productDescription,
      category: "Serum",
      images: [],
      options: [],
      benefits: [],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: ["Apply Glow Serum to clean skin"],
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
    content: { sections, html: `<div>${productDescription}</div>` },
    evidenceLedger
  };
  input.publicCopyProvenance = createPdpGeoPublicCopyProvenance({
    schemaMarkup: input.schemaMarkup,
    evidenceLedger
  });
  return input;
}

function evidence(
  id: string,
  role: "description" | "source" | "faq" | "usage",
  text: string,
  sourcePath: string
) {
  return { id, role, text, sourcePath, locale: "en-US" as const, productScope: "product" as const, confidence: 1 };
}

function modelPlan(productDescription: string): PdpGeoContentPlan {
  return {
    mode: "model",
    locale: "en-US",
    productDescription: {
      include: true,
      text: productDescription,
      intent: "product-description",
      evidenceIds: ["ev-product"],
      confidence: 1,
      omitReason: ""
    },
    webPageDescription: {
      include: false,
      text: "",
      intent: "webpage-description",
      evidenceIds: [],
      confidence: 0,
      omitReason: "not supplied"
    },
    faq: [],
    howTo: {
      eligible: false,
      ordered: false,
      goal: "",
      steps: [],
      evidenceIds: [],
      confidence: 0,
      omitReason: "not supplied"
    },
    cep: [],
    warnings: []
  };
}

function readNode(jsonLd: JsonObject, type: string): Record<string, any> | undefined {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  return graph.find((item): item is Record<string, any> => (
    typeof item === "object" && item !== null && !Array.isArray(item) && item["@type"] === type
  ));
}
