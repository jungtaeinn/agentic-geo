import { describe, expect, it } from "vitest";
import type { ConceptEmbodimentAssessment } from "@agentic-geo/pdp-geo-eval-agent";
import { generatePdpGeo } from "../src";
import {
  collectConceptShortfalls,
  collectQualityGateShortfalls,
  createConceptGateFeedback,
  DEFAULT_QUALITY_GATE_THRESHOLDS,
  judgeConceptEmbodimentSafely,
  resolveQualityGateSettings,
  shouldAdoptCorrectedArtifacts
} from "../src/quality-gate";

const scores = (overall: number, geo: number, cep: number, eeat: number) => ({ overall, geo, cep, eeat });

describe("quality gate helpers", () => {
  it("defaults thresholds to GEO 90 / CEP 95 / E-E-A-T 90 and enables only with a corrective runtime", () => {
    expect(resolveQualityGateSettings(undefined, false)).toEqual({
      enabled: false,
      thresholds: { ...DEFAULT_QUALITY_GATE_THRESHOLDS }
    });
    expect(resolveQualityGateSettings(undefined, true).enabled).toBe(true);
    expect(resolveQualityGateSettings({ enabled: true, thresholds: { geo: 85 } }, false)).toEqual({
      enabled: true,
      thresholds: { geo: 85, cep: 95, eeat: 90 }
    });
  });

  it("reports every failed floor and unresolved warnings as shortfalls", () => {
    expect(collectQualityGateShortfalls(scores(100, 100, 100, 100), DEFAULT_QUALITY_GATE_THRESHOLDS, 0)).toEqual([]);
    const shortfalls = collectQualityGateShortfalls(scores(85, 78, 100, 78), DEFAULT_QUALITY_GATE_THRESHOLDS, 5);
    expect(shortfalls).toHaveLength(3);
    expect(shortfalls.join(" ")).toContain("GEO 78 < 90");
    expect(shortfalls.join(" ")).toContain("E-E-A-T 78 < 90");
    expect(shortfalls.join(" ")).toContain("5 unresolved validation warning(s)");
  });

  it("adopts corrections only when they measurably improve without adding warnings", () => {
    const initial = { scores: scores(85, 78, 100, 78), warningCount: 5 };
    expect(shouldAdoptCorrectedArtifacts(initial, { scores: scores(92, 90, 100, 90), warningCount: 0 })).toBe(true);
    // Same score, fewer warnings → adopt.
    expect(shouldAdoptCorrectedArtifacts(initial, { scores: scores(85, 78, 100, 78), warningCount: 2 })).toBe(true);
    // Higher score but MORE warnings → rollback.
    expect(shouldAdoptCorrectedArtifacts(initial, { scores: scores(95, 95, 100, 95), warningCount: 6 })).toBe(false);
    // No measurable change → rollback.
    expect(shouldAdoptCorrectedArtifacts(initial, { scores: scores(85, 78, 100, 78), warningCount: 5 })).toBe(false);
    // Lower score → rollback.
    expect(shouldAdoptCorrectedArtifacts(initial, { scores: scores(80, 70, 100, 78), warningCount: 0 })).toBe(false);
  });

  it("lets a concept-score improvement break a deterministic tie, never a regression", () => {
    const tied = { scores: scores(93, 90, 97, 93), warningCount: 0 };
    // Deterministic tie + concept improved → adopt.
    expect(shouldAdoptCorrectedArtifacts({ ...tied, conceptScore: 70 }, { ...tied, conceptScore: 85 })).toBe(true);
    // Deterministic tie + concept unchanged/absent → rollback.
    expect(shouldAdoptCorrectedArtifacts({ ...tied, conceptScore: 70 }, { ...tied, conceptScore: 70 })).toBe(false);
    expect(shouldAdoptCorrectedArtifacts(tied, tied)).toBe(false);
    // Concept improved but deterministic score regressed → rollback.
    expect(shouldAdoptCorrectedArtifacts(
      { scores: scores(93, 90, 97, 93), warningCount: 0, conceptScore: 70 },
      { scores: scores(92, 88, 97, 93), warningCount: 0, conceptScore: 95 }
    )).toBe(false);
  });

  it("turns below-floor concept dimensions into shortfalls and targeted feedback", () => {
    const assessment: ConceptEmbodimentAssessment = {
      overallScore: 80,
      summary: "CEP causal path is weak.",
      dimensions: [
        { id: "geo", score: 95, embodied: ["answers who-for"], missing: [], improvements: [] },
        { id: "cep", score: 70, embodied: [], missing: ["usage situation never connects to the ingredient story"], improvements: ["Link the dryness concern to the ceramide sentence in the description."] },
        { id: "eeat", score: 92, embodied: ["attributed reviews"], missing: [], improvements: [] }
      ]
    };
    const shortfalls = collectConceptShortfalls(assessment, DEFAULT_QUALITY_GATE_THRESHOLDS);
    expect(shortfalls).toEqual(["concept CEP 70 < 95"]);
    const feedback = createConceptGateFeedback(assessment, DEFAULT_QUALITY_GATE_THRESHOLDS);
    expect(feedback.every((item) => item.field === "concept:cep")).toBe(true);
    expect(feedback.map((item) => item.reason).join(" ")).toContain("ceramide");
    // Dimensions at/above their floor contribute nothing — advisory notes on
    // passing dimensions must not churn the corrective pass.
    expect(feedback.some((item) => item.field === "concept:geo")).toBe(false);
  });

  it("degrades gracefully when the concept judge fails instead of breaking the run", async () => {
    const result = await judgeConceptEmbodimentSafely(
      { jsonLd: { "@graph": [] }, diagnostics: { normalizedProduct: { name: "x" }, validationWarnings: [] } as never },
      { provider: "unsupported" as never, apiKey: "" } as never,
      "ko-KR"
    );
    expect(result.assessment).toBeUndefined();
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe("quality gate pipeline integration", () => {
  const product = {
    geoProduct: {
      name: "모이베리어 미스트",
      description: "세라마이드를 담은 보습 미스트입니다.",
      brand: "EXAMPLEDERMA",
      category: "미스트",
      benefits: ["수분 충전과 동시에 보습막을 형성합니다."],
      ingredients: ["세라마이드 10,000ppm"],
      usage: ["연약하고 건조해진 피부 부위에 미세 분사합니다.", "피부에 건조함이 느껴질 때 수시로 뿌려줍니다."],
      price: { amount: 23000, currency: "KRW" },
      dateModified: "2026-08-01"
    }
  };

  it("skips self-evaluation without a corrective runtime but keeps the pipeline step reported", async () => {
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    expect(run.diagnostics.qualityGate).toBeUndefined();
    const gateStep = run.process.find((step) => step.id === "quality-gate");
    expect(gateStep?.status).toBe("done");
  });

  it("evaluates with the shared rubric and records scores when a corrective runtime exists", async () => {
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      customCopyRefiner: { refineCopy: () => ({}) }
    });
    const gate = run.diagnostics.qualityGate;
    expect(gate?.enabled).toBe(true);
    expect(gate?.thresholds).toEqual({ geo: 90, cep: 95, eeat: 90 });
    expect(gate?.initialScores?.overall).toBeGreaterThan(0);
    // Either the gate passed outright or a corrective pass ran and its
    // adopt-or-rollback decision was recorded — never a silent in-between.
    if ((gate?.shortfalls.length ?? 0) === 0) {
      expect(gate?.attempted).toBe(false);
      expect(gate?.reason).toContain("passed");
    } else {
      expect(gate?.attempted).toBe(true);
      expect(typeof gate?.adopted).toBe("boolean");
    }
  });

  it("honors an explicit opt-out", async () => {
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      customCopyRefiner: { refineCopy: () => ({}) },
      qualityGate: { enabled: false }
    });
    expect(run.diagnostics.qualityGate).toBeUndefined();
  });
});
