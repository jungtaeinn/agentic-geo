import assert from "node:assert/strict";
import test from "node:test";

import { maxDuration as extractMaxDuration, POST as extract } from "../src/app/api/extract/route";
import { maxDuration as generateMaxDuration, POST as generate } from "../src/app/api/generate/route";
import { maxDuration as generatorMaxDuration, POST as generator } from "../src/app/api/generator/route";
import { POST as validateProvider } from "../src/app/api/provider/validate/route";
import { DELETE as deleteRagProfile, dynamic as ragProfileDynamic, GET as getRagProfile } from "../src/app/api/rag-profile/route";
import { POST as evaluate } from "../src/app/api/evaluation/route";

test("GEO extraction and generation BFF routes keep a 15-minute execution budget", () => {
  assert.equal(extractMaxDuration, 900);
  assert.equal(generateMaxDuration, 900);
  assert.equal(generatorMaxDuration, 900);
});

test("GEO BFF POST routes return each Python response without reconstructing it", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  const receivedUrls: string[] = [];
  const receivedInits: Array<RequestInit | undefined> = [];
  const routes = [
    [extract, "/extract"],
    [generate, "/generate"],
    [generator, "/generator"],
    [evaluate, "/evaluation"],
    [validateProvider, "/provider/validate"]
  ] as const;

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
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
    for (const [handler, path] of routes) {
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
      "http://python-agent.test/extract?request=1",
      "http://python-agent.test/generate?request=1",
      "http://python-agent.test/generator?request=1",
      "http://python-agent.test/evaluation?request=1",
      "http://python-agent.test/provider/validate?request=1"
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

test("GEO generate streams upstream NDJSON without parsing or waiting for later bytes", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  let receivedInit: RequestInit | undefined;
  let releaseSecondChunk: (() => void) | undefined;
  const secondChunk = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://python-agent.test/generate?stream=1");
    receivedInit = init;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"progress"}\n'));
      },
      async pull(controller) {
        await secondChunk;
        controller.enqueue(new TextEncoder().encode('{"type":"result"}\n'));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    });
  };

  try {
    const response = await generate(new Request("http://console.test/api/generate?stream=1", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0, 255, 10])
    }));
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(receivedInit?.cache, "no-store");
    assert.equal(new Headers(receivedInit?.headers).get("cache-control"), "no-store");
    assert.ok(response.body);

    const reader = response.body.getReader();
    assert.deepEqual((await reader.read()).value, new TextEncoder().encode('{"type":"progress"}\n'));
    releaseSecondChunk?.();
    assert.deepEqual((await reader.read()).value, new TextEncoder().encode('{"type":"result"}\n'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.AGENTIC_GEO_API_URL;
    else process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
  }
});

test("GEO RAG profile keeps every query and never sends an extractor selector", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  let receivedHeaders = new Headers();
  const receivedUrls: string[] = [];
  const receivedInits: Array<RequestInit | undefined> = [];

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
  globalThis.fetch = async (input, init) => {
    receivedUrls.push(String(input));
    receivedHeaders = new Headers(init?.headers);
    receivedInits.push(init);
    return new Response('{"extractor":{},"generator":{}}', {
      status: 206,
      statusText: "Combined profile",
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    const response = await getRagProfile(new Request("http://console.test/api/rag-profile?target=generator", {
      headers: { "x-neo-console": "spoofed" }
    }));
    assert.equal(response.status, 206);
    assert.equal(response.statusText, "Combined profile");
    assert.equal(ragProfileDynamic, "force-dynamic");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(receivedHeaders.has("x-neo-console"), false);
    assert.equal(await response.text(), '{"extractor":{},"generator":{}}');
    const deleteResponse = await deleteRagProfile(new Request("http://console.test/api/rag-profile?target=generator&version=2", {
      method: "DELETE",
      headers: { "x-neo-console": "spoofed" }
    }));
    assert.equal(deleteResponse.status, 206);
    assert.equal(deleteResponse.headers.get("cache-control"), "no-store, no-transform");
    assert.deepEqual(receivedUrls, [
      "http://python-agent.test/rag-profile?target=generator",
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

test("GEO evaluation BFF proxies the browser evaluator DTO unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  let receivedUrl = "";

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test";
  globalThis.fetch = async (input) => {
    receivedUrl = String(input);
    return new Response('{"overallScore":93}', {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  try {
    const response = await evaluate(new Request("http://console.test/api/evaluation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":{"jsonLd":{"@type":"Product"},"diagnostics":{}},"language":"en"}'
    }));
    assert.equal(response.status, 202);
    assert.equal(response.statusText, "Accepted");
    assert.equal(await response.text(), '{"overallScore":93}');
    assert.equal(receivedUrl, "http://python-agent.test/evaluation");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.AGENTIC_GEO_API_URL;
    else process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
  }
});
