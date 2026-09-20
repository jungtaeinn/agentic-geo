import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStoredHistoryQueue,
  prependHistoryQueueItems,
  serializeExtractorHistoryForSession
} from "../src/app/components/ExtractorConsole";

function queueItem(id: string, source = "https://example.test/products/cream?variant=42") {
  const signedImage = "https://cdn.example.test/detail.png?X-Amz-Signature=private-signature#ocr-slice-1";
  return {
    id,
    source,
    status: "done",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:01:00.000Z",
    result: {
      source,
      sourceType: "url",
      geoProduct: {
        name: `Product ${id}`,
        images: [signedImage],
        reviews: { keywords: [] },
        ocr: { textBlocks: [] },
        contentAnalysis: { sections: [] },
        rag: { chunks: [] },
        sourceExtraction: { ocr: { imageUrl: signedImage, apiKey: "private-key" } }
      },
      generatedAt: "2026-09-14T00:01:00.000Z",
      ragProfile: "default",
      diagnostics: {
        source,
        sourceType: "url",
        process: [{ id: "ocr", title: "OCR", description: "OCR", status: "done", metrics: { ocrImageCandidateCount: 2 } }],
        evidence: [{ field: "ocr", source: signedImage, value: "private-copy" }],
        warnings: [],
        generatedAt: "2026-09-14T00:01:00.000Z",
        ragProfile: "default",
        provider: "aistudio",
        endpoint: "https://private.example.test/agent",
        apiKey: "private-key",
        ocr: {
          provider: "aistudio",
          targetsConsidered: 2,
          inputsSent: 1,
          targets: [{ imageUrl: signedImage, status: "extracted", textLength: 91, confidence: 0.9 }]
        }
      }
    },
    diagnostics: {
      apiKey: "private-key"
    }
  } as any;
}

test("extractor session history redacts secret-bearing OCR data while keeping an older result reopenable", () => {
  const newest = queueItem("newest");
  const payload = serializeExtractorHistoryForSession([newest, queueItem("older-a"), queueItem("older-b")], 3_000);

  assert.ok(new TextEncoder().encode(payload).byteLength <= 3_000);
  for (const privateValue of ["private-key", "private-signature", "private.example.test", "X-Amz-Signature"]) {
    assert.equal(payload.includes(privateValue), false);
  }

  const restored = normalizeStoredHistoryQueue(JSON.parse(payload));
  assert.equal(restored[0]?.id, "newest");
  assert.equal(restored[0]?.source, "https://example.test/products/cream?variant=42");
  assert.deepEqual(restored[0]?.result?.geoProduct.images, ["https://cdn.example.test/detail.png"]);
  assert.equal((restored[0]?.result?.diagnostics as any)?.ocr?.targets?.[0]?.imageUrl, "https://cdn.example.test/detail.png");
});

test("extractor history retains distinct runs for the same source", () => {
  const source = "https://example.test/products/cream";
  const history = prependHistoryQueueItems([queueItem("run-b", source)], [queueItem("run-a", source)]);

  assert.deepEqual(history.map((item) => item.id), ["run-b", "run-a"]);
  assert.deepEqual(history.map((item) => item.source), [source, source]);
});

test("extractor session history compacts one oversized newest artifact below its byte budget while keeping it reopenable", () => {
  const newest = queueItem("oversized");
  newest.result.geoProduct.longText = "source-copy-".repeat(2_000);
  newest.result.geoProduct.rag = {
    chunks: Array.from({ length: 50 }, (_, index) => ({
      id: `chunk-${index}`,
      kind: "ocr",
      text: "rag-copy-".repeat(500)
    }))
  };

  const payload = serializeExtractorHistoryForSession([newest], 1_000);

  assert.ok(new TextEncoder().encode(payload).byteLength <= 1_000);
  const restored = normalizeStoredHistoryQueue(JSON.parse(payload));
  assert.equal(restored[0]?.id, "oversized");
  assert.equal(restored[0]?.result?.geoProduct.name, "Product oversized");
  assert.ok(restored[0]?.result?.geoProduct.rag);
});

test("extractor history sanitizes signed top-level source URLs and secret-bearing error text", () => {
  const entry = queueItem("sensitive", "https://example.test/products/cream?variant=42&token=private-source-token");
  entry.status = "error";
  entry.result = undefined;
  entry.error = "Request to https://private.example.test/agent?signature=private-error-signature failed: apiKey=private-error-key";

  const payload = serializeExtractorHistoryForSession([entry]);

  for (const privateValue of ["private-source-token", "private-error-signature", "private-error-key"]) {
    assert.equal(payload.includes(privateValue), false);
  }
  const restored = normalizeStoredHistoryQueue(JSON.parse(payload));
  assert.equal(restored[0]?.source, "https://example.test/products/cream?variant=42");
  assert.equal(restored[0]?.error?.includes("private-error-key"), false);
  assert.equal(restored[0]?.error?.includes("private-error-signature"), false);
});

test("extractor history redacts quoted JSON credentials in errors without discarding normal diagnostic text", () => {
  const entry = queueItem("json-error");
  entry.status = "error";
  entry.result = undefined;
  entry.error = 'Provider failed: {"apiKey":"sk-secret","authorization":"Bearer abc123"} token=plainsecret. Retry later.';

  const payload = serializeExtractorHistoryForSession([entry]);

  for (const secret of ["sk-secret", "Bearer abc123", "plainsecret"]) {
    assert.equal(payload.includes(secret), false);
  }
  const restored = normalizeStoredHistoryQueue(JSON.parse(payload));
  assert.match(restored[0]?.error ?? "", /^Provider failed:/);
  assert.match(restored[0]?.error ?? "", /Retry later\.$/);
});

test("extractor history preserves diagnostic token usage while redacting credential fields", () => {
  const entry = queueItem("usage");
  entry.result.diagnostics.runtimeUsage = {
    steps: [{
      stage: "ocr",
      tokenUsage: {
        inputTokens: 321,
        outputTokens: 89
      },
      accessToken: "private-access-token",
      bearerToken: "private-bearer-token",
      apiToken: "private-api-token"
    }]
  };

  const payload = serializeExtractorHistoryForSession([entry]);
  const restored = normalizeStoredHistoryQueue(JSON.parse(payload));
  const step = (restored[0]?.result?.diagnostics as any)?.runtimeUsage?.steps?.[0];

  assert.deepEqual(step?.tokenUsage, { inputTokens: 321, outputTokens: 89 });
  assert.equal("accessToken" in (step ?? {}), false);
  assert.equal("bearerToken" in (step ?? {}), false);
  assert.equal("apiToken" in (step ?? {}), false);
  for (const secret of ["private-access-token", "private-bearer-token", "private-api-token"]) {
    assert.equal(payload.includes(secret), false);
  }
});
