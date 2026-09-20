import assert from "node:assert/strict";
import test from "node:test";

import {
  appendGeoHistoryEntries,
  normalizeStoredExtractorHistoryV2,
  normalizeStoredGeoHistoryV2,
  serializeExtractorHistoryForSession,
  serializeGeoHistoryForSession
} from "../src/app/components/GeoGeneratorConsole";

function historyEntry(id: string, source = "https://example.test/product") {
  const diagnosticMarker = `diagnostic-${id}`;
  const diagnostics = {
    diagnosticMarker,
    evidence: ["e".repeat(1_000)]
  };

  return {
    entryId: `entry-${id}`,
    runId: `run-${id}`,
    result: {
      id,
      source,
      sourceType: "url",
      generator: {
        locale: "en-US",
        schemaMarkup: { jsonLd: { "@type": "Product", name: id } },
        content: { sections: { productName: id } },
        diagnostics,
        generatedAt: "2026-09-14T00:00:00.000Z",
        ragProfile: "default"
      }
    },
    log: {
      entryId: `entry-${id}`,
      runId: `run-${id}`,
      source,
      generator: diagnostics,
      generatorProcess: []
    }
  } as any;
}

test("generator session history keeps the newest complete artifact inside a byte budget without storing its diagnostics twice", () => {
  const newest = historyEntry("newest");
  const payload = serializeGeoHistoryForSession(
    [newest, historyEntry("older-a"), historyEntry("older-b")],
    [],
    2_000
  );

  assert.ok(new TextEncoder().encode(payload).byteLength <= 2_000);
  assert.equal(payload.split("diagnostic-newest").length - 1, 1);

  const restored = normalizeStoredGeoHistoryV2(JSON.parse(payload));
  assert.equal(restored?.entries[0]?.entryId, "entry-newest");
  assert.deepEqual(restored?.entries[0]?.result.generator.schemaMarkup.jsonLd, { "@type": "Product", name: "newest" });
  assert.equal(restored?.entries[0]?.log?.generator.diagnosticMarker, "diagnostic-newest");
});

test("generator session history keeps runtime token usage while redacting credential tokens", () => {
  const entry = historyEntry("runtime-usage");
  entry.result.generator.diagnostics = {
    ...entry.result.generator.diagnostics,
    runtimeUsage: {
      steps: [{ stage: "contentPlanning", tokenUsage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 }, accessToken: "secret-token" }],
      tokenTotals: { inputTokens: 21, outputTokens: 8, totalTokens: 29 }
    }
  };

  const payload = serializeGeoHistoryForSession([entry], []);
  const restored = normalizeStoredGeoHistoryV2(JSON.parse(payload));
  const usage = restored?.entries[0]?.result.generator.diagnostics.runtimeUsage;

  assert.equal(payload.includes("secret-token"), false);
  assert.deepEqual(usage?.steps[0]?.tokenUsage, { inputTokens: 21, outputTokens: 8, totalTokens: 29 });
  assert.deepEqual(usage?.tokenTotals, { inputTokens: 21, outputTokens: 8, totalTokens: 29 });
});

test("generator session history compacts one oversized newest artifact below its byte budget while keeping it reopenable", () => {
  const newest = historyEntry("oversized");
  newest.result.generator.schemaMarkup = {
    jsonLd: {
      "@type": "Product",
      name: "Oversized Barrier Serum",
      description: "schema-copy-".repeat(2_000)
    }
  };
  newest.result.generator.content = {
    sections: {
      productName: "Oversized Barrier Serum",
      productDescription: "content-copy-".repeat(2_000)
    }
  };

  const payload = serializeGeoHistoryForSession([newest], [], 1_000);

  assert.ok(new TextEncoder().encode(payload).byteLength <= 1_000);
  const restored = normalizeStoredGeoHistoryV2(JSON.parse(payload));
  assert.equal(restored?.entries[0]?.entryId, "entry-oversized");
  assert.equal(restored?.entries[0]?.result.generator.content.sections.productName, "Oversized Barrier Serum");
  assert.ok(restored?.entries[0]?.result.generator.schemaMarkup.jsonLd);
});

test("generator history restores an older v2 entry whose paired diagnostics were stored inline", () => {
  const legacyEntry = historyEntry("legacy");
  const restored = normalizeStoredGeoHistoryV2({
    version: 2,
    entries: [legacyEntry],
    unpairedLegacyLogs: []
  });

  assert.equal(restored?.entries[0]?.entryId, "entry-legacy");
  assert.equal(restored?.entries[0]?.log?.generator.diagnosticMarker, "diagnostic-legacy");
});

test("generator history keeps distinct runs for the same source URL", () => {
  const source = "https://example.test/product?variant=gold";
  const history = appendGeoHistoryEntries([historyEntry("second", source)], [historyEntry("first", source)]);

  assert.deepEqual(history.map((entry) => entry.entryId), ["entry-second", "entry-first"]);
});

test("generator session history redacts signed source and embedded OCR image URLs while preserving safe source parameters", () => {
  const source = "https://example.test/product?variant=gold&signature=private-source-signature";
  const signedImage = "https://cdn.example.test/ocr.png?sig=private-image-signature&expires=9999";
  const entry = historyEntry("signed", source);
  entry.result.extractor = {
    source,
    sourceType: "url",
    geoProduct: { name: "Barrier Serum", images: [signedImage], rag: { chunks: [] } },
    generatedAt: "2026-09-14T00:00:00.000Z",
    ragProfile: "default"
  };
  entry.result.generator.schemaMarkup = { jsonLd: { "@type": "Product", image: signedImage } };
  entry.result.generator.diagnostics = {
    ...entry.result.generator.diagnostics,
    validationWarnings: ['Provider failed: {"apiKey":"sk-secret","authorization":"Bearer abc123"} token=plainsecret. Retry later.'],
    ocrSentences: [{ text: "OCR", imageUrls: [signedImage], intents: [], schemaFields: [], geoUse: "support" }]
  };
  entry.result.citationProbeError = "Citation request to https://private.example.test/probe?signature=private-error-signature failed: apiKey=private-error-key";

  const payload = serializeGeoHistoryForSession([entry], []);

  assert.equal(payload.includes("private-source-signature"), false);
  assert.equal(payload.includes("private-image-signature"), false);
  assert.equal(payload.includes("private-error-signature"), false);
  assert.equal(payload.includes("private-error-key"), false);
  assert.equal(payload.includes("sk-secret"), false);
  assert.equal(payload.includes("Bearer abc123"), false);
  assert.equal(payload.includes("plainsecret"), false);
  const restored = normalizeStoredGeoHistoryV2(JSON.parse(payload));
  assert.equal(restored?.entries[0]?.result.source, "https://example.test/product?variant=gold");
  assert.equal((restored?.entries[0]?.result.extractor?.geoProduct.images?.[0] as string).includes("?"), false);
  assert.equal((restored?.entries[0]?.result.generator.schemaMarkup.jsonLd.image as string).includes("?"), false);
  assert.equal(restored?.entries[0]?.result.citationProbeError, undefined);
  assert.match(restored?.entries[0]?.result.generator.diagnostics.validationWarnings[0] ?? "", /^Provider failed:/);
  assert.match(restored?.entries[0]?.result.generator.diagnostics.validationWarnings[0] ?? "", /Retry later\.$/);
});

test("extractor session history keeps the newest result reopenable without persisting signed OCR URLs or duplicate diagnostics", () => {
  const source = "https://example.test/product?variant=gold";
  const signedImage = "https://cdn.example.test/ocr.png?signature=private-signature&expires=9999";
  const entry = {
    entryId: "extractor-entry",
    runId: "extractor-run",
    result: {
      source,
      sourceType: "url",
      geoProduct: {
        name: "Barrier Serum",
        images: [signedImage],
        longText: "x".repeat(8_000),
        rag: { chunks: [] }
      },
      generatedAt: "2026-09-14T00:00:00.000Z",
      ragProfile: "default"
    },
    log: {
      entryId: "extractor-entry",
      runId: "extractor-run",
      source,
      sourceType: "url",
      process: [],
      evidence: [{ imageUrl: signedImage, apiKey: "private-key" }],
      warnings: [],
      ocr: { targets: [{ imageUrl: signedImage, status: "extracted" }] },
      generatedAt: "2026-09-14T00:00:00.000Z",
      ragProfile: "default"
    }
  } as any;

  const payload = serializeExtractorHistoryForSession([entry], [], 3_000);

  assert.ok(new TextEncoder().encode(payload).byteLength <= 3_000);
  assert.equal(payload.includes("private-signature"), false);
  assert.equal(payload.includes("private-key"), false);
  const restored = normalizeStoredExtractorHistoryV2(JSON.parse(payload));
  assert.equal(restored?.entries[0]?.result.geoProduct.name, "Barrier Serum");
  assert.equal(restored?.entries[0]?.result.source, source);
  assert.equal((restored?.entries[0]?.result.geoProduct.images?.[0] as string).includes("?"), false);
  assert.equal((restored?.entries[0]?.log?.ocr.targets?.[0]?.imageUrl as string).includes("?"), false);
});

test("generator-owned extractor history compacts one oversized newest artifact below its byte budget", () => {
  const entry = {
    entryId: "extractor-oversized-entry",
    runId: "extractor-oversized-run",
    result: {
      source: "https://example.test/product?variant=gold",
      sourceType: "url",
      geoProduct: {
        name: "Oversized Extractor Serum",
        longText: "source-copy-".repeat(2_000),
        rag: { chunks: Array.from({ length: 50 }, (_, index) => ({ id: `chunk-${index}`, kind: "ocr", text: "rag-copy-".repeat(500) })) }
      },
      generatedAt: "2026-09-14T00:00:00.000Z",
      ragProfile: "default"
    }
  } as any;

  const payload = serializeExtractorHistoryForSession([entry], [], 1_000);

  assert.ok(new TextEncoder().encode(payload).byteLength <= 1_000);
  const restored = normalizeStoredExtractorHistoryV2(JSON.parse(payload));
  assert.equal(restored?.entries[0]?.entryId, "extractor-oversized-entry");
  assert.equal(restored?.entries[0]?.result.geoProduct.name, "Oversized Extractor Serum");
});
