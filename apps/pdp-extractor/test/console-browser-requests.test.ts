import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultProviderSettings,
  defaultRagProfileSettings,
  defaultRestApiSettings,
  requestExtraction,
  requestRagProfile,
  resetPackageRagProfile,
  validateProviderConnection,
  writeRagProfile
} from "../src/app/components/ExtractorConsole";

test("Extractor console production requests select FastAPI endpoints in Pages mode and Next BFF endpoints locally", async () => {
  const originalFetch = globalThis.fetch;
  const previousDeployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const previousBaseUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  const calls: Array<{ url: string; selector: string | null; cache: RequestCache | undefined; headers: Headers }> = [];
  const openAiSettings = { ...defaultProviderSettings, provider: "openai" as const, openaiApiKey: "test-key", openaiModel: "gpt-test" };

  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      selector: headers.get("x-neo-console"),
      cache: init?.cache,
      headers
    });
    return new Response(JSON.stringify({
      results: [],
      logs: [],
      failures: [],
      profile: "default",
      analysisPrompt: "",
      documents: [],
      ok: true,
      message: "connected",
      models: []
    }), { headers: { "content-type": "application/json" } });
  };

  try {
    process.env.NEXT_PUBLIC_DEPLOY_TARGET = "github-pages";
    process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL = "https://python-agent.example/base/";
    await runConsoleRequests(openAiSettings);
    assert.deepEqual(calls.map(({ url }) => url), [
      "https://python-agent.example/base/extract",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/rag-profile",
      "https://python-agent.example/base/provider/validate"
    ]);
    assert.deepEqual(calls.map(({ selector }) => selector), [null, "extractor", "extractor", "extractor", null]);
    for (const call of calls) {
      assert.equal(call.cache, "no-store");
      assert.equal(call.headers.get("cache-control"), "no-store");
    }

    calls.length = 0;
    delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
    await runConsoleRequests(openAiSettings);
    assert.deepEqual(calls.map(({ url }) => url), [
      "/api/extract",
      "/api/rag-profile",
      "/api/rag-profile",
      "/api/rag-profile",
      "/api/provider/validate"
    ]);
    assert.deepEqual(calls.map(({ selector }) => selector), [null, "extractor", "extractor", "extractor", null]);
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

test("extractor requests bypass caches and retain only an exactly echoed request ID", async () => {
  const originalFetch = globalThis.fetch;
  const settings = { ...defaultProviderSettings, provider: "openai" as const, openaiApiKey: "test-key", openaiModel: "gpt-test" };
  const calls: RequestInit[] = [];
  let requestCount = 0;

  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    calls.push(init ?? {});
    return new Response(JSON.stringify({ results: [], logs: [], failures: [] }), {
      headers: {
        "content-type": "application/json",
        "x-request-id": requestCount === 1 ? "run-42" : "unrelated-run"
      }
    });
  };

  try {
    const first = await requestExtraction(["https://example.test/pdp"], settings, defaultRestApiSettings, defaultRagProfileSettings, "run-42");
    const second = await requestExtraction(["https://example.test/pdp"], settings, defaultRestApiSettings, defaultRagProfileSettings, "run-42");

    assert.equal((first as any).requestId, "run-42");
    assert.equal((second as any).requestId, undefined);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.cache, "no-store");
      assert.equal(new Headers(call.headers).get("cache-control"), "no-store");
      assert.equal(new Headers(call.headers).get("x-request-id"), "run-42");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function runConsoleRequests(providerSettings: typeof defaultProviderSettings): Promise<void> {
  await requestExtraction(["https://example.test/pdp"], providerSettings, defaultRestApiSettings, defaultRagProfileSettings);
  await requestRagProfile();
  await writeRagProfile(defaultRagProfileSettings);
  await resetPackageRagProfile();
  await validateProviderConnection(providerSettings);
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
