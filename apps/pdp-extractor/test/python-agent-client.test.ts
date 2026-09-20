import assert from "node:assert/strict";
import test from "node:test";

import { proxyPythonAgent } from "../src/app/lib/python-agent-client";

test("extractor BFF preserves NDJSON and correlation semantics without forwarding untrusted headers", async () => {
  const originalFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENTIC_GEO_API_URL;
  const requestBytes = new Uint8Array([0, 255, 10, 123, 125]);
  const responseBytes = new Uint8Array([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125, 10]);
  let receivedHeaders = new Headers();
  let receivedBytes = new Uint8Array();

  process.env.AGENTIC_GEO_API_URL = "http://python-agent.test/base/";
  globalThis.fetch = async (_input, init) => {
    receivedHeaders = new Headers(init?.headers);
    receivedBytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    return new Response(responseBytes, {
      status: 207,
      statusText: "Partial Result",
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-request-id": "python-request-42",
        "x-accel-buffering": "no",
        "x-upstream-trace": "not-public",
        "set-cookie": "upstream-session=secret; HttpOnly",
        "www-authenticate": "Basic realm=upstream",
        connection: "close"
      }
    });
  };

  try {
    const response = await proxyPythonAgent(
      new Request("http://next-console.test/api/extract?batch=two", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          authorization: "Bearer browser-secret",
          connection: "keep-alive",
          "content-type": "application/octet-stream",
          cookie: "session=browser-secret",
          host: "next-console.test",
          "x-request-id": "browser-request-7",
          "x-neo-console": "spoofed",
          "x-forwarded-for": "203.0.113.7"
        },
        body: requestBytes
      }),
      "/extract"
    );

    assert.deepEqual(receivedBytes, requestBytes);
    assert.equal(receivedHeaders.get("accept"), "application/x-ndjson");
    assert.equal(receivedHeaders.get("content-type"), "application/octet-stream");
    assert.equal(receivedHeaders.get("x-request-id"), "browser-request-7");
    assert.equal(receivedHeaders.has("x-neo-console"), false);
    assert.equal(receivedHeaders.has("authorization"), false);
    assert.equal(receivedHeaders.has("connection"), false);
    assert.equal(receivedHeaders.has("cookie"), false);
    assert.equal(receivedHeaders.has("host"), false);
    assert.equal(receivedHeaders.has("x-forwarded-for"), false);
    assert.equal(receivedHeaders.get("cache-control"), "no-store");
    assert.equal(response.status, 207);
    assert.equal(response.statusText, "Partial Result");
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(response.headers.get("x-request-id"), "python-request-42");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(response.headers.has("connection"), false);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.has("www-authenticate"), false);
    assert.equal(response.headers.has("x-upstream-trace"), false);
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), responseBytes);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.AGENTIC_GEO_API_URL;
    } else {
      process.env.AGENTIC_GEO_API_URL = previousBaseUrl;
    }
  }
});
