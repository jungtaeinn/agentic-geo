import assert from "node:assert/strict";
import test from "node:test";

import { maxDuration as extractMaxDuration, POST as extract } from "../src/app/api/extract/route";
import { POST as validateProvider } from "../src/app/api/provider/validate/route";
import { DELETE as deleteRagProfile, dynamic as ragProfileDynamic, GET as getRagProfile, PUT as putRagProfile } from "../src/app/api/rag-profile/route";
import { POST as mock } from "../src/app/api/mock/route";
import { POST as refine } from "../src/app/api/refine/route";

test("extractor BFF keeps a 15-minute execution budget for Python extraction", () => {
  assert.equal(extractMaxDuration, 900);
});

test("extractor BFF POST routes return raw Python responses", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  const receivedUrls: string[] = [];
  const receivedInits: Array<RequestInit | undefined> = [];

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test/agent-api/";
  globalThis.fetch = async (input, init) => {
    receivedUrls.push(String(input));
    receivedInits.push(init);
    return new Response(new Uint8Array([0, 255, 10]), {
      status: 207,
      statusText: "Python partial",
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "content-length": "123",
        "x-request-id": "python-post"
      }
    });
  };

  try {
    for (const [handler, path] of [[extract, "/extract"], [validateProvider, "/provider/validate"]] as const) {
      const response = await handler(new Request(`http://console.test/api${path}?request=1`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 255, 10])
      }));
      assert.equal(response.status, 207);
      assert.equal(response.statusText, "Python partial");
      assert.equal(response.headers.get("x-request-id"), "python-post");
      assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("content-length"), null);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 10]));
    }
    assert.deepEqual(receivedUrls, [
      "http://python-agent.test/agent-api/extract?request=1",
      "http://python-agent.test/agent-api/provider/validate?request=1"
    ]);
    for (const init of receivedInits) {
      assert.equal(init?.cache, "no-store");
      assert.equal(new Headers(init?.headers).get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.AGENTIC_GEO_API_URL;
    else process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
  }
});

test("extractor RAG profile selects the raw profile for GET, PUT, and DELETE", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  const receivedSelectors: Array<string | null> = [];
  const receivedMethods: string[] = [];
  const receivedUrls: string[] = [];
  const receivedInits: Array<RequestInit | undefined> = [];

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
  globalThis.fetch = async (input, init) => {
    receivedUrls.push(String(input));
    const headers = new Headers(init?.headers);
    receivedSelectors.push(headers.get("x-neo-console"));
    receivedMethods.push(init?.method ?? "GET");
    receivedInits.push(init);
    return new Response('{"profile":"extractor"}', {
      status: 206,
      statusText: "Extractor profile",
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    const getResponse = await getRagProfile(new Request("http://console.test/api/rag-profile?raw=true", {
      headers: { "x-neo-console": "spoofed" }
    }));
    const putResponse = await putRagProfile(new Request("http://console.test/api/rag-profile?raw=true", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-neo-console": "spoofed" },
      body: new Uint8Array([0, 255, 10])
    }));
    const deleteResponse = await deleteRagProfile(new Request("http://console.test/api/rag-profile?target=generator&version=2", {
      method: "DELETE",
      headers: { "x-neo-console": "spoofed" }
    }));

    assert.equal(getResponse.status, 206);
    assert.equal(putResponse.status, 206);
    assert.equal(deleteResponse.status, 206);
    assert.equal(ragProfileDynamic, "force-dynamic");
    assert.equal(getResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(putResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(deleteResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.deepEqual(receivedMethods, ["GET", "PUT", "DELETE"]);
    assert.deepEqual(receivedSelectors, ["extractor", "extractor", "extractor"]);
    assert.deepEqual(receivedUrls, [
      "http://python-agent.test/rag-profile?raw=true",
      "http://python-agent.test/rag-profile?raw=true",
      "http://python-agent.test/rag-profile?target=generator&version=2"
    ]);
    for (const init of receivedInits) {
      assert.equal(init?.cache, "no-store");
      assert.equal(new Headers(init?.headers).get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.AGENTIC_GEO_API_URL;
    else process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
  }
});

test("extractor browser-seam BFF routes proxy direct mock and refinement payloads", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  const receivedUrls: string[] = [];
  const receivedInits: Array<RequestInit | undefined> = [];

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
  globalThis.fetch = async (input, init) => {
    receivedUrls.push(String(input));
    receivedInits.push(init);
    return new Response('{"result":{"source":"https://example.test/pdp"},"changes":["name"],"summary":"updated"}', {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    const mockResponse = await mock(new Request("http://console.test/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["https://example.test/pdp"]'
    }));
    const refineResponse = await refine(new Request("http://console.test/api/refine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"result":{"source":"https://example.test/pdp"},"instruction":"rename"}'
    }));

    assert.equal(mockResponse.status, 202);
    assert.equal(refineResponse.status, 202);
    assert.equal(mockResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(refineResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(await mockResponse.text(), '{"result":{"source":"https://example.test/pdp"},"changes":["name"],"summary":"updated"}');
    assert.equal(await refineResponse.text(), '{"result":{"source":"https://example.test/pdp"},"changes":["name"],"summary":"updated"}');
    assert.deepEqual(receivedUrls, ["http://python-agent.test/mock", "http://python-agent.test/refine"]);
    for (const init of receivedInits) {
      assert.equal(init?.cache, "no-store");
      assert.equal(new Headers(init?.headers).get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.AGENTIC_GEO_API_URL;
    else process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
  }
});
