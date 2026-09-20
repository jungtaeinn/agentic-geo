import assert from "node:assert/strict";
import test from "node:test";

import {
  requestGeoProductRefinement,
  requestMockProductExtraction
} from "../src/app/lib/python-agent-browser-client";

test("static extractor clients preserve the direct mock and refinement DTOs at the configured external base", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  const calls: Array<{ url: string; body: unknown; cache: RequestCache | undefined; headers: Headers }> = [];
  const mockRuns = [{ result: { source: "https://example.test/pdp", sourceType: "mock", geoProduct: { name: "Hydra" } }, diagnostics: { source: "https://example.test/pdp" } }];
  const refinement = { result: { source: "https://example.test/pdp", sourceType: "mock", geoProduct: { name: "Updated Hydra" } }, changes: ["name"], summary: "updated" };

  process.env.NEXT_PUBLIC_DEPLOY_TARGET = "github-pages";
  process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example/base/";
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      cache: init?.cache,
      headers: new Headers(init?.headers)
    });
    return new Response(JSON.stringify(calls.length === 1 ? mockRuns : refinement), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    const receivedMockRuns = await requestMockProductExtraction(["https://example.test/pdp"]);
    const receivedRefinement = await requestGeoProductRefinement({
      result: mockRuns[0]!.result,
      instruction: '{"geoProduct":{"name":"Updated Hydra"}}'
    });

    assert.deepEqual(receivedMockRuns, mockRuns);
    assert.deepEqual(receivedRefinement, refinement);
    assert.deepEqual(calls.map(({ url, body }) => ({ url, body })), [
      { url: "https://python-agent.example/base/mock", body: ["https://example.test/pdp"] },
      {
        url: "https://python-agent.example/base/refine",
        body: {
          result: mockRuns[0]!.result,
          instruction: '{"geoProduct":{"name":"Updated Hydra"}}'
        }
      }
    ]);
    for (const call of calls) {
      assert.equal(call.cache, "no-store");
      assert.equal(call.headers.get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("NEXT_PUBLIC_DEPLOY_TARGET", previousDeployTarget);
    restoreEnvironment("NEXT_PUBLIC_AGENTIC_GEO_API_URL", previousBaseUrl);
  }
});

test("local extractor clients use their Next routes even when a static external base is configured", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  let requestedUrl = "";

  delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response("[]", { headers: { "content-type": "application/json" } });
  };

  try {
    await requestMockProductExtraction([]);
    assert.equal(requestedUrl, "/api/mock");
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
