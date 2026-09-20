import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizePdpGeoDiagnosticsForDisplay,
  resolvePublicCopyOmissions,
  resolveGeoGeneratorFailureDiagnostics,
  resolveGeoGeneratorFailureMessage,
  requestGeoExtractor,
  requestGeoGenerator,
  requestRagProfiles,
  resetPackageRagProfile,
  validateProviderConnection,
  writeRagProfile
} from "../src/app/components/GeoGeneratorConsole";

test("GEO console removes raw omission fields before serializing successful diagnostics", () => {
  const privateCopy = "Barrier Serum transforms dry skin overnight.";
  const privateUrl = "https://private.example.test/evidence";
  const privateKey = "credential-must-not-appear";
  const diagnostics = sanitizePdpGeoDiagnosticsForDisplay({
    normalizedProduct: { name: "Barrier Serum" },
    ocrSentences: [],
    recommendations: [],
    evidence: [],
    selectedRagChunks: [],
    ragUsage: [],
    terminology: {},
    validationWarnings: [],
    ragMode: "local-versioned-rag",
    generatedAt: "2026-09-13T00:00:00.000Z",
    publicCopyOmissions: [{
      fieldPath: "Product.description",
      action: "sentenceOmitted",
      reason: "directSupportRejected",
      count: 1,
      sentenceIndex: 0,
      text: privateCopy,
      sourceUrl: privateUrl,
      apiKey: privateKey
    }]
  } as any);

  assert.deepEqual(diagnostics.publicCopyOmissions, [{
    fieldPath: "Product.description",
    action: "sentenceOmitted",
    reason: "directSupportRejected",
    count: 1,
    sentenceIndex: 0
  }]);
  const renderedDiagnostics = JSON.stringify(diagnostics);
  for (const privateValue of [privateCopy, privateUrl, privateKey, "sourceUrl", "apiKey"]) {
    assert.equal(renderedDiagnostics.includes(privateValue), false);
  }
});

test("GEO console retains only allowlisted public-copy omission diagnostics on a successful run", () => {
  const privateCopy = "Barrier Serum transforms dry skin overnight.";
  const privateEvidence = "Private source evidence must not reach the UI.";
  const privateUrl = "https://private.example.test/evidence";
  const privateKey = "credential-must-not-appear";

  const omissions = resolvePublicCopyOmissions([
    {
      fieldPath: "Product.description",
      action: "sentenceOmitted",
      reason: "directSupportRejected",
      count: 1,
      sentenceIndex: 0,
      text: privateCopy,
      evidenceIds: ["private-evidence"],
      sourceUrl: privateUrl,
      apiKey: privateKey
    },
    {
      fieldPath: "FAQPage.mainEntity[0].acceptedAnswer.text",
      action: "faqItemOmitted",
      reason: "unresolvedBinding",
      count: 1,
      sentenceIndex: null,
      source: privateEvidence
    },
    {
      fieldPath: privateUrl,
      action: "sentenceOmitted",
      reason: "directSupportRejected",
      count: 1,
      sentenceIndex: 0
    },
    {
      fieldPath: "WebPage.description",
      action: "replacementInserted",
      reason: "directSupportRejected",
      count: 1,
      sentenceIndex: 0
    }
  ]);

  assert.deepEqual(omissions, [
    {
      fieldPath: "Product.description",
      action: "sentenceOmitted",
      reason: "directSupportRejected",
      count: 1,
      sentenceIndex: 0
    },
    {
      fieldPath: "FAQPage.mainEntity[0].acceptedAnswer.text",
      action: "faqItemOmitted",
      reason: "unresolvedBinding",
      count: 1,
      sentenceIndex: null
    }
  ]);

  const renderedDiagnostics = JSON.stringify(omissions);
  for (const privateValue of [privateCopy, privateEvidence, privateUrl, privateKey, "private-evidence", "evidenceIds", "sourceUrl", "apiKey"]) {
    assert.equal(renderedDiagnostics.includes(privateValue), false);
  }
});

test("GEO console surfaces the first source failure before the generic run error", () => {
  assert.equal(
    resolveGeoGeneratorFailureMessage({
      error: "GEO generation failed.",
      failures: [
        {
          source: "https://example.test/pdp",
          sourceType: "url",
          error: "The model request timed out after 900 seconds."
        }
      ]
    }),
    "The model request timed out after 900 seconds."
  );
});

test("GEO console filters failure provenance fields before rendering or copying diagnostics", () => {
  const diagnostics = resolveGeoGeneratorFailureDiagnostics({
    failures: [{
      source: "manual-json-1",
      sourceType: "manual-json",
      error: "Quality gate blocked final artifact.",
      diagnostics: {
        qualityGate: { attempted: true, adopted: false },
        validationFindings: [
          {
            field: "Product.description",
            source: "public-copy-provenance",
            reason: "Final public-copy provenance binding is missing."
          },
          {
            field: "https://private.example.test/internal-field",
            source: "public-copy-provenance",
            reason: "Final public-copy provenance binding is missing."
          },
          {
            field: "Internal.auditTrail",
            source: "public-copy-provenance",
            reason: "Final public-copy provenance binding is missing."
          }
        ],
        finalPublicCopyProvenance: {
          count: 99,
          fieldPaths: [
            "Product.description",
            "FAQPage.mainEntity[0].acceptedAnswer.text",
            "HowTo.step[1].text",
            "https://private.example.test/internal-field",
            "Internal.auditTrail",
            "Product.description"
          ]
        }
      }
    }]
  });

  assert.deepEqual(diagnostics?.validationFindings, [{
    field: "Product.description",
    source: "public-copy-provenance",
    reason: "Final public-copy provenance binding is missing."
  }]);
  assert.deepEqual(diagnostics?.finalPublicCopyProvenance, {
    count: 3,
    fieldPaths: [
      "Product.description",
      "FAQPage.mainEntity[0].acceptedAnswer.text",
      "HowTo.step[1].text"
    ]
  });
});

test("GEO console uses diagnostics from the first failure that has recognized diagnostics", () => {
  const payload: Parameters<typeof resolveGeoGeneratorFailureMessage>[0] = {
    error: "GEO generation failed.",
    failures: [
      {
        source: "manual-json-1",
        sourceType: "manual-json",
        error: "The first source failed to parse.",
        diagnostics: { qualityGate: "not-a-diagnostic-record" }
      },
      {
        source: "manual-json-2",
        sourceType: "manual-json",
        error: "Quality gate blocked final artifact.",
        diagnostics: {
          qualityGate: { attempted: true, adopted: false },
          validationFindings: [{
            field: "Product.description",
            source: "public-copy-provenance",
            reason: "Final public-copy provenance binding is missing."
          }],
          finalPublicCopyProvenance: {
            count: 1,
            fieldPaths: ["Product.description"]
          }
        }
      }
    ]
  };

  assert.equal(resolveGeoGeneratorFailureMessage(payload), "The first source failed to parse.");
  assert.deepEqual(resolveGeoGeneratorFailureDiagnostics(payload), {
    process: [],
    qualityGate: {
      attempted: true,
      adopted: false,
      reason: "Quality gate blocked final artifact.",
      shortfalls: [],
      blockingShortfalls: [],
      scores: {}
    },
    validationFindings: [{
      field: "Product.description",
      source: "public-copy-provenance",
      reason: "Final public-copy provenance binding is missing."
    }],
    finalPublicCopyProvenance: { count: 1, fieldPaths: ["Product.description"] },
    runtimeStages: []
  });
});

test("GEO console retains a generic safe failure execution envelope without a quality gate", () => {
  const privateKey = "credential-must-not-reach-failure-panel";
  const diagnostics = resolveGeoGeneratorFailureDiagnostics({
    failures: [{
      source: "https://example.test/pdp",
      sourceType: "url",
      error: "Generation failed after extraction.",
      diagnostics: {
        process: [
          { id: "input", status: "done", message: privateKey },
          { id: "generate", status: "error", message: privateKey }
        ],
        runtimeStages: {
          contentPlanning: { called: true, applied: false, apiKey: privateKey },
          rag: { retrievedCount: 4, selectedRagCount: 2, endpoint: "https://private.example.test/rag" }
        },
        extractor: {
          process: [{ id: "ocr", status: "done", metrics: { ocrImageCandidateCount: 3 } }],
          diagnostics: {
            warningCount: 1,
            evidenceCount: 5,
            runtimeStages: [{ stage: "ocr", called: true, apiKey: privateKey }]
          }
        },
        apiKey: privateKey
      }
    }]
  });

  assert.deepEqual(diagnostics, {
    process: [
      { id: "input", status: "done" },
      { id: "generate", status: "error" }
    ],
    validationFindings: [],
    finalPublicCopyProvenance: { count: 0, fieldPaths: [] },
    runtimeStages: [
      { stage: "contentPlanning", called: true, applied: false },
      { stage: "rag", retrievedCount: 4, selectedRagCount: 2 }
    ],
    extractor: {
      process: [{ id: "ocr", status: "done" }],
      diagnostics: {
        warningCount: 1,
        evidenceCount: 5,
        runtimeStages: [{ stage: "ocr", called: true }]
      }
    }
  });
  assert.equal(JSON.stringify(diagnostics).includes(privateKey), false);
  assert.equal(JSON.stringify(diagnostics).includes("private.example.test"), false);
});

test("GEO console retains safe quality-gate diagnostics from an NDJSON terminal failure", async () => {
  const originalFetch = globalThis.fetch;
  const diagnostics = {
    process: [
      { id: "input", status: "done" },
      { id: "quality-gate", status: "error" }
    ],
    qualityGate: {
      attempted: true,
      adopted: false,
      reason: "Quality gate blocked final artifact after corrective refinement.",
      shortfalls: ["1 unresolved public-copy provenance warning(s)"],
      blockingShortfalls: ["1 unresolved public-copy provenance warning(s)"],
      scores: { initial: { overall: 80, geo: 80, cep: 100, eeat: 100 } }
    },
    validationFindings: [
      {
        field: "Product.description",
        source: "public-copy-provenance",
        reason: "Final public-copy provenance binding is missing."
      }
    ],
    finalPublicCopyProvenance: { count: 0, fieldPaths: [] },
    runtimeStages: { copyRefinement: { called: true, applied: false } },
    apiKey: "must-not-reach-the-panel",
    endpoint: "https://private.example.test/must-not-reach-the-panel"
  };
  const payload = {
    results: [],
    logs: [],
    failures: [
      {
        source: "manual-json-1",
        sourceType: "manual-json",
        error: "Quality gate blocked final artifact after corrective refinement.",
        diagnostics
      }
    ]
  };

  globalThis.fetch = async () => new Response(`${JSON.stringify({ type: "result", payload })}\n`, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" }
  });

  try {
    const response = await requestGeoGenerator({ product: { name: "Barrier Serum" } }, () => undefined);

    assert.equal(response.ok, false);
    assert.deepEqual(response.payload.failures[0]?.diagnostics, diagnostics);
    assert.deepEqual(resolveGeoGeneratorFailureDiagnostics(response.payload), {
      process: [
        { id: "input", status: "done" },
        { id: "quality-gate", status: "error" }
      ],
      qualityGate: {
        attempted: true,
        adopted: false,
        reason: "Quality gate blocked final artifact after corrective refinement.",
        shortfalls: ["1 unresolved public-copy provenance warning(s)"],
        blockingShortfalls: ["1 unresolved public-copy provenance warning(s)"],
        scores: { initial: { overall: 80, geo: 80, cep: 100, eeat: 100 } }
      },
      validationFindings: [
        {
          field: "Product.description",
          source: "public-copy-provenance",
          reason: "Final public-copy provenance binding is missing."
        }
      ],
      finalPublicCopyProvenance: { count: 0, fieldPaths: [] },
      runtimeStages: [{ stage: "copyRefinement", called: true, applied: false }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GEO console retains only allowlisted corrective and provenance-decision diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const privateCopy = "Glow Serum visibly transforms dry skin overnight.";
  const privateSource = "The internal source record must not be published.";
  const privateUrl = "https://private.example.test/evidence";
  const privateKey = "credential-must-not-appear";
  const payload = {
    results: [],
    logs: [],
    failures: [
      {
        source: "manual-json-1",
        sourceType: "manual-json",
        error: "Quality gate blocked final artifact after corrective refinement.",
        diagnostics: {
          process: [{ id: "quality-gate", status: "error" }],
          qualityGate: {
            attempted: true,
            adopted: false,
            reason: "Quality gate blocked final artifact after corrective refinement.",
            shortfalls: ["1 unresolved public-copy provenance warning(s)"],
            blockingShortfalls: ["1 unresolved public-copy provenance warning(s)"],
            correctiveDiagnostics: {
              correctiveApplied: true,
              correctedMissingPaths: ["Product.description", privateUrl],
              adoptionReason: "provenanceRegression",
              structuralShortfallCount: 0,
              provenanceRegressionDelta: 1,
              candidateCopy: privateCopy,
              sourceUrl: privateUrl,
              apiKey: privateKey
            }
          },
          validationFindings: [],
          finalPublicCopyProvenance: { count: 0, fieldPaths: [] },
          publicCopyProvenanceDecisionDiagnostics: [
            {
              fieldPath: "Product.description",
              phase: "correctedCandidate",
              sentenceIndex: 0,
              outcome: "unsupported",
              reason: "assertionFrameRejected",
              plan: {
                mode: "model",
                fieldIncluded: true,
                textHashMatch: false,
                text: privateCopy,
                sourceHash: "fnv1a-secret"
              },
              eligibleEvidenceCount: 1,
              eligibleRoleCounts: { description: 1, internal: 99 },
              selectedEvidenceCount: 0,
              text: privateCopy,
              source: privateSource,
              sourceUrl: privateUrl,
              apiKey: privateKey,
              evidenceIds: ["private-evidence"],
              sourceHash: "fnv1a-secret"
            },
            {
              fieldPath: privateUrl,
              phase: "initial",
              sentenceIndex: 0,
              outcome: "unsupported",
              reason: "noEligibleEvidence"
            }
          ]
        }
      }
    ]
  };

  globalThis.fetch = async () => new Response(`${JSON.stringify({ type: "result", payload })}\n`, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" }
  });

  try {
    const response = await requestGeoGenerator({ product: { name: "Barrier Serum" } }, () => undefined);
    const diagnostics = resolveGeoGeneratorFailureDiagnostics(response.payload);

    assert.deepEqual(diagnostics?.qualityGate?.correctiveDiagnostics, {
      correctiveApplied: true,
      correctedMissingPaths: ["Product.description"],
      adoptionReason: "provenanceRegression",
      structuralShortfallCount: 0,
      provenanceRegressionDelta: 1
    });
    assert.deepEqual(diagnostics?.publicCopyProvenanceDecisionDiagnostics, [
      {
        fieldPath: "Product.description",
        phase: "correctedCandidate",
        sentenceIndex: 0,
        outcome: "unsupported",
        reason: "assertionFrameRejected",
        plan: { mode: "model", fieldIncluded: true, textHashMatch: false },
        eligibleEvidenceCount: 1,
        eligibleRoleCounts: { description: 1 },
        selectedEvidenceCount: 0
      }
    ]);

    const renderedDiagnostics = JSON.stringify(diagnostics);
    for (const privateValue of [
      privateCopy,
      privateSource,
      privateUrl,
      privateKey,
      "private-evidence",
      "fnv1a-secret",
      "candidateCopy",
      "sourceUrl",
      "apiKey",
      "sourceHash",
      "evidenceIds"
    ]) {
      assert.equal(renderedDiagnostics.includes(privateValue), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GEO console production requests select FastAPI endpoints in Pages mode and Next BFF endpoints locally", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  const calls: string[] = [];
  const inits: RequestInit[] = [];

  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    inits.push(init ?? {});
    return new Response(JSON.stringify({
      results: [],
      logs: [],
      failures: [],
      extractor: { analysisPrompt: "", documents: [] },
      generator: { analysisPrompt: "", documents: [] },
      ok: true,
      message: "connected",
      models: []
    }), { headers: { "content-type": "application/json" } });
  };

  try {
    process.env.NEXT_PUBLIC_DEPLOY_TARGET = "github-pages";
    process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example/base/";
    await runConsoleRequests();
    assert.deepEqual(calls, [
      "https://python-agent.example/base/extract",
      "https://python-agent.example/base/generate",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/rag-profile?target=generator",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/provider/validate"
    ]);
    for (const init of inits) {
      assert.equal(init.cache, "no-store");
      assert.equal(new Headers(init.headers).get("cache-control"), "no-store");
    }

    calls.length = 0;
    inits.length = 0;
    delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
    await runConsoleRequests();
    assert.deepEqual(calls, [
      "/api/extract",
      "/api/generate",
      "/api/rag-profile",
      "/api/rag-profile",
      "/api/rag-profile",
      "/api/rag-profile?target=generator",
      "/api/rag-profile",
      "/api/provider/validate"
    ]);
    for (const init of inits) {
      assert.equal(init.cache, "no-store");
      assert.equal(new Headers(init.headers).get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("NEXT_PUBLIC_DEPLOY_TARGET", previousDeployTarget);
    restoreEnvironment("NEXT_PUBLIC_AGENTIC_GEO_API_URL", previousBaseUrl);
  }
});

async function runConsoleRequests(): Promise<void> {
  await requestGeoExtractor({ sources: ["https://example.test/pdp"] });
  await requestGeoGenerator({ sources: ["https://example.test/pdp"] }, () => undefined);
  await requestRagProfiles();
  await writeRagProfile("generator", { profile: "generator", analysisPrompt: "", files: [] });
  await resetPackageRagProfile("generator");
  await validateProviderConnection({ provider: "mock" } as Parameters<typeof validateProviderConnection>[0]);
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
