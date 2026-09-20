import assert from "node:assert/strict";
import test from "node:test";

import { requestGeoQualityEvaluation } from "../src/app/lib/python-agent-browser-client";

test("GEO evaluation client preserves the direct evaluator input and language DTO at the static external base", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  let requestUrl = "";
  let requestBody: unknown;
  const evaluation = {
    overallScore: 93,
    dimensions: [{ id: "geo", label: "GEO", score: 93, criteria: "structure", summary: "healthy", evidence: [], improvements: [] }],
    validationDetails: [],
    validationImprovements: []
  };

  process.env.NEXT_PUBLIC_DEPLOY_TARGET = "github-pages";
  process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example/base/";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(evaluation), { headers: { "content-type": "application/json; charset=utf-8" } });
  };

  try {
    const input = { jsonLd: { "@type": "Product" }, diagnostics: { normalizedProduct: {}, validationWarnings: [] } };
    const received = await requestGeoQualityEvaluation(input, "en");

    assert.deepEqual(received, evaluation);
    assert.equal(requestUrl, "https://python-agent.example/base/evaluation");
    assert.deepEqual(requestBody, { input, language: "en" });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("NEXT_PUBLIC_DEPLOY_TARGET", previousDeployTarget);
    restoreEnvironment("NEXT_PUBLIC_AGENTIC_GEO_API_URL", previousBaseUrl);
  }
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
