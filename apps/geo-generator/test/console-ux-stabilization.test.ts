import assert from "node:assert/strict";
import test from "node:test";

import {
  appendExtractorHistoryEntries,
  appendGeoHistoryEntries,
  createExtractorHistoryEntries,
  createGeoHistoryEntries,
  findExtractorHistoryEntry,
  findGeoHistoryEntry,
  migrateExtractorHistoryV1,
  migrateGeoHistoryV1,
  normalizeStoredExtractorHistoryV2,
  requestGeoExtractor,
  requestGeoGenerator,
  resolveCurrentRunProcess,
  resolveSelectedGeneratorFailureDiagnostics,
  resolvePanelSources,
  resolveRunResultCount,
  shouldApplyRunUpdate
} from "../src/app/components/GeoGeneratorConsole";

function geoResult(id: string, source = "https://example.test/product") {
  return {
    id,
    source,
    sourceType: "url",
    generator: {
      generatedAt: "2026-09-13T00:00:00.000Z",
      locale: "en-US",
      schemaMarkup: { jsonLd: {} },
      content: { sections: { productName: id } },
      diagnostics: {}
    }
  } as any;
}

function geoLog(source = "https://example.test/product") {
  return {
    source,
    generator: { marker: source },
    generatorProcess: []
  } as any;
}

function extractorResult(source = "https://example.test/product") {
  return {
    source,
    sourceType: "url",
    geoProduct: { name: source },
    generatedAt: "2026-09-13T00:00:00.000Z",
    ragProfile: "default"
  } as any;
}

function extractorLog(source = "https://example.test/product") {
  return {
    source,
    sourceType: "url",
    process: [],
    evidence: [],
    warnings: [],
    generatedAt: "2026-09-13T00:00:00.000Z",
    ragProfile: "default"
  } as any;
}

test("generator submissions forward an echoed request ID into durable history", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedInit: RequestInit | undefined;
  const requestId = "run-generator-42";

  globalThis.fetch = async (_input, init) => {
    receivedInit = init;
    return new Response(JSON.stringify({ results: [], logs: [], failures: [] }), {
      headers: { "content-type": "application/json", "x-request-id": requestId }
    });
  };

  try {
    const response = await requestGeoGenerator({ products: [] }, () => undefined, controller.signal, requestId);
    const history = createGeoHistoryEntries([geoResult("server-result")], [geoLog()], requestId, () => "entry-42", response.requestId);

    assert.equal(receivedInit?.cache, "no-store");
    assert.equal(new Headers(receivedInit?.headers).get("cache-control"), "no-store");
    assert.equal(new Headers(receivedInit?.headers).get("x-request-id"), requestId);
    assert.equal(receivedInit?.signal, controller.signal);
    assert.equal(response.requestId, requestId);
    assert.equal(history.entries[0]?.requestId, requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractor submissions forward an echoed request ID into durable history", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedInit: RequestInit | undefined;
  const requestId = "run-extractor-42";

  globalThis.fetch = async (_input, init) => {
    receivedInit = init;
    return new Response(JSON.stringify({ results: [], logs: [], failures: [] }), {
      headers: { "content-type": "application/json", "x-request-id": requestId }
    });
  };

  try {
    const response = await requestGeoExtractor({ sources: [] }, controller.signal, requestId);
    const history = createExtractorHistoryEntries([extractorResult()], [extractorLog()], requestId, () => "entry-42", response.requestId);

    assert.equal(receivedInit?.cache, "no-store");
    assert.equal(new Headers(receivedInit?.headers).get("cache-control"), "no-store");
    assert.equal(new Headers(receivedInit?.headers).get("x-request-id"), requestId);
    assert.equal(receivedInit?.signal, controller.signal);
    assert.equal(response.requestId, requestId);
    assert.equal(history.entries[0]?.requestId, requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("standalone extractor session history retains only allowlisted OCR proof diagnostics", () => {
  const privateKey = "credential-must-not-survive-history";
  const restored = normalizeStoredExtractorHistoryV2({
    version: 2,
    entries: [{
      entryId: "entry-ocr-proof",
      runId: "run-ocr-proof",
      requestId: "request-ocr-proof",
      result: extractorResult(),
      log: {
        ...extractorLog(),
        apiKey: privateKey,
        ocr: {
          provider: "aistudio",
          targetsConsidered: 3,
          inputsSent: 2,
          targets: [{
            imageUrl: "https://cdn.example.test/detail.png?signature=private",
            sliced: true,
            sliceCount: 4,
            status: "extracted",
            textLength: 91,
            confidence: 0.91,
            issues: [`request used ${privateKey}`],
            apiKey: privateKey
          }],
          combination: {
            candidatesIn: 3,
            duplicatesAbsorbed: 1,
            overlapJoins: 1,
            candidatesOut: 2,
            droppedCandidates: [privateKey]
          },
          classification: {
            batches: 1,
            failedBatches: 0,
            providerKeywords: 7,
            sentenceInsights: 4,
            confidence: 0.92,
            apiKey: privateKey
          },
          utilization: {
            textBlocksInResult: 2,
            keywordsAttached: 7,
            ragChunksFromOcr: 2,
            unusedTexts: [privateKey]
          },
          endpoint: "https://private.example.test/ocr",
          apiKey: privateKey
        }
      }
    }],
    unpairedLegacyLogs: []
  });

  assert.deepEqual(restored?.entries[0]?.requestId, "request-ocr-proof");
  assert.deepEqual(restored?.entries[0]?.log?.ocr, {
    provider: "aistudio",
    targetsConsidered: 3,
    inputsSent: 2,
    targets: [{
      imageUrl: "https://cdn.example.test/detail.png",
      sliced: true,
      sliceCount: 4,
      status: "extracted",
      textLength: 91,
      confidence: 0.91
    }],
    combination: {
      candidatesIn: 3,
      duplicatesAbsorbed: 1,
      overlapJoins: 1,
      candidatesOut: 2
    },
    classification: {
      batches: 1,
      failedBatches: 0,
      providerKeywords: 7,
      sentenceInsights: 4,
      confidence: 0.92
    },
    utilization: {
      textBlocksInResult: 2,
      keywordsAttached: 7,
      ragChunksFromOcr: 2
    }
  });
  const persisted = JSON.stringify(restored);
  for (const privateValue of [privateKey, "signature=private", "private.example.test", "issues", "droppedCandidates", "unusedTexts"]) {
    assert.equal(persisted.includes(privateValue), false);
  }
});

test("repeat generator sources retain distinct, atomically paired durable history entries", () => {
  const first = createGeoHistoryEntries([geoResult("server-result-a")], [geoLog()], "run-a", () => "entry-a");
  const second = createGeoHistoryEntries([geoResult("server-result-b")], [geoLog()], "run-b", () => "entry-b");
  const history = appendGeoHistoryEntries(second.entries, first.entries);

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => entry.entryId), ["entry-b", "entry-a"]);
  assert.deepEqual(history.map((entry) => entry.runId), ["run-b", "run-a"]);
  assert.equal(history[0]?.log?.entryId, "entry-b");
  assert.equal(history[1]?.log?.entryId, "entry-a");
  assert.equal(findGeoHistoryEntry(history, "entry-a")?.result.id, "server-result-a");
});

test("repeat extractor sources retain distinct, atomically paired durable history entries", () => {
  const first = createExtractorHistoryEntries([extractorResult()], [extractorLog()], "run-a", () => "entry-a");
  const second = createExtractorHistoryEntries([extractorResult()], [extractorLog()], "run-b", () => "entry-b");
  const history = appendExtractorHistoryEntries(second.entries, first.entries);

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => entry.entryId), ["entry-b", "entry-a"]);
  assert.equal(history[0]?.log?.entryId, "entry-b");
  assert.equal(findExtractorHistoryEntry(history, "entry-a")?.result.source, "https://example.test/product");
});

test("v1 generator migration leaves an ambiguous source-only diagnostic unpaired", () => {
  const migrated = migrateGeoHistoryV1({
    results: [
      geoResult("legacy-url", "https://example.test/product"),
      { ...geoResult("legacy-rest", "https://example.test/product"), sourceType: "restApi" }
    ],
    logs: [geoLog("https://example.test/product")]
  }, (index) => `generated-${index}`);

  assert.equal(migrated.entries.length, 2);
  assert.deepEqual(migrated.entries.map((entry) => entry.log), [undefined, undefined]);
  assert.equal(migrated.unpairedLegacyLogs.length, 1);
  assert.equal(migrated.unpairedLegacyLogs[0]?.reason, "ambiguous-v1-source");
});

test("v1 extractor migration leaves an ambiguous source-only diagnostic unpaired", () => {
  const migrated = migrateExtractorHistoryV1({
    results: [
      extractorResult("https://example.test/product"),
      { ...extractorResult("https://example.test/product"), sourceType: "restApi" }
    ],
    logs: [extractorLog("https://example.test/product")]
  }, (index) => `generated-${index}`);

  assert.equal(migrated.entries.length, 2);
  assert.deepEqual(migrated.entries.map((entry) => entry.log), [undefined, undefined]);
  assert.equal(migrated.unpairedLegacyLogs.length, 1);
  assert.equal(migrated.unpairedLegacyLogs[0]?.reason, "ambiguous-v1-source");
});

test("late or aborted runs cannot apply progress or completion updates", () => {
  assert.equal(shouldApplyRunUpdate(3, 3, false), true);
  assert.equal(shouldApplyRunUpdate(4, 3, false), false);
  assert.equal(shouldApplyRunUpdate(3, 3, true), false);
});

test("the current run keeps its source and failure state ahead of a selected history entry", () => {
  const running = {
    status: "running",
    currentGroup: "extractor",
    currentStepId: "ocr",
    sourceCount: 1,
    completedSourceCount: 0,
    activeSource: "https://example.test/new-run"
  } as const;
  const failed = { ...running, status: "error" as const };

  assert.deepEqual(
    resolvePanelSources(resolveCurrentRunProcess("running", running), "https://example.test/selected-history"),
    ["https://example.test/new-run"]
  );
  assert.deepEqual(
    resolvePanelSources(resolveCurrentRunProcess("error", failed), "https://example.test/selected-history"),
    ["https://example.test/new-run"]
  );
});

test("failure diagnostics stay bound to their originating generator run when history changes", () => {
  const failure = {
    runId: "failed-run",
    diagnostics: { process: [{ id: "generate", status: "error" }] }
  } as any;

  assert.equal(resolveSelectedGeneratorFailureDiagnostics(failure, "saved-run"), undefined);
  assert.deepEqual(resolveSelectedGeneratorFailureDiagnostics(failure, "failed-run"), failure.diagnostics);
  assert.deepEqual(resolveSelectedGeneratorFailureDiagnostics(failure, undefined), failure.diagnostics);
});

test("an idle history selection remains visible when there is no current run", () => {
  assert.equal(resolveCurrentRunProcess("done", {
    status: "done",
    currentGroup: "generator",
    currentStepId: "artifact",
    sourceCount: 1,
    completedSourceCount: 1,
    activeSource: "https://example.test/new-run"
  }), undefined);
  assert.deepEqual(resolvePanelSources(undefined, "https://example.test/selected-history"), ["https://example.test/selected-history"]);
});

test("the completed-run summary counts this run instead of every saved history entry", () => {
  assert.equal(resolveRunResultCount("done", {
    status: "done",
    completedSourceCount: 1
  }, 2), 1);
  assert.equal(resolveRunResultCount("done", {
    status: "idle",
    completedSourceCount: 0
  }, 2), 2);
});
