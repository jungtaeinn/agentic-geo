import assert from "node:assert/strict";
import test from "node:test";

import * as consoleModule from "../src/app/components/GeoGeneratorConsole";
import { localizeProcessStep, requestGeoExtractor } from "../src/app/components/GeoGeneratorConsole";

type ProcessStatus = "pending" | "running" | "done" | "error";

interface ExtractorInFlightProcess {
  status: ProcessStatus;
  currentGroup: "extractor" | "generator";
  currentStepId: string;
  sourceCount: number;
  completedSourceCount: number;
  activeSource?: string;
}

interface ExtractorProgressContract {
  createStandaloneExtractorInFlightProcess(input: { sources: string[] }): ExtractorInFlightProcess;
  getPipelineStepStatus(
    stepId: string,
    group: "extractor" | "generator",
    process: ExtractorInFlightProcess
  ): ProcessStatus;
  resolveStandaloneExtractorProcessSnapshot(
    payload: { logs: Array<{ source: string; process: unknown[] }> },
    source: string
  ): { source: string; process: unknown[] } | undefined;
}

const progress = consoleModule as typeof consoleModule & ExtractorProgressContract;

test("standalone extractor keeps downstream stages pending until its JSON snapshot arrives", async () => {
  const originalFetch = globalThis.fetch;
  const source = "https://fixture.test/pdp";
  let releaseResponse: ((response: Response) => void) | undefined;
  const snapshot = {
    source,
    sourceType: "url" as const,
    process: [
      { id: "input" as const, title: "backend input", description: "backend input", status: "done" as const },
      { id: "fetch" as const, title: "backend fetch", description: "backend fetch", status: "done" as const },
      { id: "extract" as const, title: "backend extract", description: "backend extract", status: "done" as const },
      { id: "ocr" as const, title: "backend ocr", description: "backend ocr", status: "done" as const, metrics: { ocrImageCandidateCount: 3 } },
      { id: "review" as const, title: "backend review", description: "backend review", status: "done" as const, metrics: { reviewItemCount: 2 } },
      { id: "rag" as const, title: "backend rag", description: "backend rag", status: "done" as const, metrics: { ragChunkCount: 5 } },
      { id: "json" as const, title: "backend json", description: "backend json", status: "done" as const }
    ],
    evidence: [],
    warnings: [],
    generatedAt: "2026-09-13T00:00:00.000Z",
    ragProfile: "default"
  };
  const payload = {
    results: [{
      source,
      sourceType: "url" as const,
      geoProduct: { rag: { chunks: [] } },
      generatedAt: "2026-09-13T00:00:00.000Z",
      ragProfile: "default"
    }],
    logs: [snapshot],
    failures: []
  };

  globalThis.fetch = async () => new Promise<Response>((resolve) => {
    releaseResponse = resolve;
  });

  try {
    assert.equal(typeof progress.createStandaloneExtractorInFlightProcess, "function");
    assert.equal(typeof progress.getPipelineStepStatus, "function");
    assert.equal(typeof progress.resolveStandaloneExtractorProcessSnapshot, "function");

    const pendingRequest = requestGeoExtractor({ sources: [source] });
    const inFlight = progress.createStandaloneExtractorInFlightProcess({ sources: [source] });

    await new Promise((resolve) => setTimeout(resolve, 920));

    assert.deepEqual(inFlight, {
      status: "running",
      currentGroup: "extractor",
      currentStepId: "fetch",
      sourceCount: 1,
      completedSourceCount: 0,
      activeSource: source
    });
    assert.deepEqual(
      Object.fromEntries(snapshot.process.map((step) => [step.id, progress.getPipelineStepStatus(step.id, "extractor", inFlight)])),
      {
        input: "done",
        fetch: "running",
        extract: "pending",
        ocr: "pending",
        review: "pending",
        rag: "pending",
        json: "pending"
      }
    );

    releaseResponse?.(new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" }
    }));
    const received = await pendingRequest;
    const receivedSnapshot = progress.resolveStandaloneExtractorProcessSnapshot(received.payload, source);

    assert.deepEqual(receivedSnapshot, snapshot);
    const ocrStep = receivedSnapshot?.process[3] as typeof snapshot.process[number];
    assert.deepEqual(ocrStep.metrics, { ocrImageCandidateCount: 3 });
    localizeProcessStep(ocrStep, "extractor", "en");
    localizeProcessStep(ocrStep, "extractor", "ko");
    assert.deepEqual(ocrStep.metrics, { ocrImageCandidateCount: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
