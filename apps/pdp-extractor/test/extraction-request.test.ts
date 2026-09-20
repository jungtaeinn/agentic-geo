import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultProviderSettings,
  defaultRagProfileSettings,
  defaultRestApiSettings,
  canSubmitExtractorPrompt,
  requestExtraction
} from "../src/app/components/ExtractorConsole";

test("the production mock provider path uses the local and static mock browser endpoints and keeps result adaptation", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  const calls: string[] = [];
  const mockRun = {
    result: {
      source: "https://example.test/pdp",
      sourceType: "mock",
      geoProduct: { rag: { chunks: [] } },
      generatedAt: "2026-09-11T00:00:00.000Z",
      ragProfile: "default"
    },
    diagnostics: {
      source: "https://example.test/pdp",
      sourceType: "mock",
      process: [],
      evidence: [],
      warnings: [],
      generatedAt: "2026-09-11T00:00:00.000Z",
      ragProfile: "default"
    }
  };
  const rag = {
    ...defaultRagProfileSettings,
    analysisPrompt: "Keep this source-backed instruction."
  };

  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify([mockRun]), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    assert.equal(canSubmitExtractorPrompt({
      providerSettings: defaultProviderSettings,
      isProviderSettingsReady: true,
      connectionStatus: "connected",
      isAgentBusy: false
    }), true);
    assert.equal(canSubmitExtractorPrompt({
      providerSettings: { ...defaultProviderSettings, provider: "openai" },
      isProviderSettingsReady: true,
      connectionStatus: "connected",
      isAgentBusy: false
    }), false);

    delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
    process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://ignored-in-local.example";
    const local = await requestExtraction(
      ["https://example.test/pdp"],
      defaultProviderSettings,
      { ...defaultRestApiSettings, sourceMode: "url" },
      rag
    );

    process.env.NEXT_PUBLIC_DEPLOY_TARGET = "github-pages";
    process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example/base/";
    const staticallyHosted = await requestExtraction(
      ["https://example.test/pdp"],
      defaultProviderSettings,
      { ...defaultRestApiSettings, sourceMode: "auto" },
      rag
    );

    assert.deepEqual(calls, ["/api/mock", "https://python-agent.example/base/mock"]);
    assert.equal(local.failures.length, 0);
    assert.equal(local.results[0]?.source, "https://example.test/pdp");
    assert.deepEqual(local.results[0]?.diagnostics, mockRun.diagnostics);
    assert.deepEqual(local.results[0]?.geoProduct.rag.chunks, [{
      id: "rag-profile-analysis-prompt",
      kind: "source",
      text: "Keep this source-backed instruction."
    }]);
    assert.deepEqual(staticallyHosted.results[0]?.geoProduct.rag.chunks, local.results[0]?.geoProduct.rag.chunks);
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
