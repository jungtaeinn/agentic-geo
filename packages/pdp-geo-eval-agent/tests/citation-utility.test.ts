import { describe, expect, it } from "vitest";
import {
  DEFAULT_UTILITY_GATE_THRESHOLDS,
  evaluateUtilityGate,
  parseCitationSupport,
  parseExtractedClaims,
  parseKeypointJudgments,
  scoreCitationQuality,
  scoreKeypointCoverage,
  type CitationSupportJudgment,
  type ExtractedClaim
} from "../src/citation/utility";

describe("parseKeypointJudgments", () => {
  it("parses valid judgments including fenced JSON", () => {
    const raw = "```json\n" + JSON.stringify({
      "ev-1": { label: "Supported", justification: "Matches the ceramide claim." },
      "ev-2": { label: "Contradicted", justification: "Document says 8 weeks, evidence says 6 weeks." }
    }) + "\n```";
    const judgments = parseKeypointJudgments(raw, ["ev-1", "ev-2"]);
    expect(judgments["ev-1"]!.label).toBe("Supported");
    expect(judgments["ev-2"]!.label).toBe("Contradicted");
  });

  it("rejects a response missing an expected evidence id", () => {
    const raw = JSON.stringify({ "ev-1": { label: "Supported", justification: "ok" } });
    expect(() => parseKeypointJudgments(raw, ["ev-1", "ev-2"])).toThrow(/missing evidence id "ev-2"/);
  });

  it("rejects invalid labels and empty justifications", () => {
    expect(() => parseKeypointJudgments(
      JSON.stringify({ "ev-1": { label: "Maybe", justification: "?" } }),
      ["ev-1"]
    )).toThrow(/invalid label/);
    expect(() => parseKeypointJudgments(
      JSON.stringify({ "ev-1": { label: "Supported", justification: "" } }),
      ["ev-1"]
    )).toThrow(/no justification/);
  });
});

describe("scoreKeypointCoverage", () => {
  it("computes KPR and KPC with contradiction details", () => {
    const score = scoreKeypointCoverage({
      "ev-1": { label: "Supported", justification: "a" },
      "ev-2": { label: "Supported", justification: "b" },
      "ev-3": { label: "Omitted", justification: "c" },
      "ev-4": { label: "Contradicted", justification: "unit changed from ml to oz" }
    });
    expect(score.kpr).toBeCloseTo(0.5, 10);
    expect(score.kpc).toBeCloseTo(0.25, 10);
    expect(score.contradictions).toEqual([
      { evidenceId: "ev-4", justification: "unit changed from ml to oz" }
    ]);
  });
});

describe("parseExtractedClaims", () => {
  it("parses claims and defaults missing ids/indices", () => {
    const claims = parseExtractedClaims(JSON.stringify({
      claims: [
        { claimId: 1, claim: "The toner contains ceramide capsules.", sourceIndices: [2] },
        { claim: "It is a bestseller.", sourceIndices: "not-a-list" }
      ]
    }));
    expect(claims).toHaveLength(2);
    expect(claims[0]!.sourceIndices).toEqual([2]);
    expect(claims[1]!.claimId).toBe(2);
    expect(claims[1]!.sourceIndices).toEqual([]);
  });

  it("rejects responses without a claims array", () => {
    expect(() => parseExtractedClaims(JSON.stringify({ items: [] }))).toThrow(/no "claims" array/);
  });
});

describe("parseCitationSupport", () => {
  it("parses a valid support judgment", () => {
    const judgment = parseCitationSupport(JSON.stringify({ support: "partial_support", justification: "Only volume matches." }));
    expect(judgment.support).toBe("partial_support");
  });

  it("rejects invalid support levels", () => {
    expect(() => parseCitationSupport(JSON.stringify({ support: "kinda", justification: "x" }))).toThrow(/invalid level/);
  });
});

describe("scoreCitationQuality", () => {
  const claims: ExtractedClaim[] = [
    { claimId: 1, claim: "Claim with two sources.", sourceIndices: [0, 1] },
    { claimId: 2, claim: "Claim with one weak source.", sourceIndices: [2] },
    { claimId: 3, claim: "Uncited claim.", sourceIndices: [] }
  ];

  it("uses max support across sources for precision (AutoGEO parity)", () => {
    const supports = new Map<number, CitationSupportJudgment[]>([
      [1, [
        { support: "partial_support", justification: "half" },
        { support: "full_support", justification: "full" }
      ]],
      [2, [{ support: "partial_support", justification: "weak" }]]
    ]);
    const score = scoreCitationQuality(claims, supports);
    // claim 1 best = 1.0, claim 2 best = 0.5 → precision 0.75
    expect(score.precision).toBeCloseTo(0.75, 10);
    expect(score.recall).toBeCloseTo(2 / 3, 10);
    expect(score.weakClaims).toHaveLength(1);
    expect(score.weakClaims[0]!.bestSupport).toBe("partial_support");
  });

  it("returns nulls when no claims were extracted", () => {
    const score = scoreCitationQuality([], new Map());
    expect(score.precision).toBeNull();
    expect(score.recall).toBeNull();
  });

  it("scores a claim whose citations are all out of range as no_support (hallucinated)", () => {
    const hallucinated: ExtractedClaim[] = [
      { claimId: 1, claim: "Backed only by a nonexistent source.", sourceIndices: [7] }
    ];
    const score = scoreCitationQuality(hallucinated, new Map());
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(1);
    expect(score.weakClaims).toHaveLength(1);
    expect(score.weakClaims[0]!.bestSupport).toBe("no_support");
  });
});

describe("evaluateUtilityGate", () => {
  const cleanCoverage = {
    kpr: 0.9,
    kpc: 0,
    supported: 9,
    omitted: 1,
    contradicted: 0,
    total: 10,
    contradictions: []
  };

  it("passes when visibility improves and utility is intact", () => {
    const result = evaluateUtilityGate({
      visibilityDelta: 0.05,
      keypointCoverage: cleanCoverage,
      citationQuality: { precision: 0.9, recall: 0.8, citedClaims: 8, totalClaims: 10, weakClaims: [] }
    });
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.skippedChecks).toEqual([]);
  });

  it("fails on any evidence contradiction (KPC gate)", () => {
    const result = evaluateUtilityGate({
      visibilityDelta: 0.1,
      keypointCoverage: {
        ...cleanCoverage,
        kpc: 0.1,
        contradicted: 1,
        contradictions: [{ evidenceId: "ev-9", justification: "claim strength inflated" }]
      }
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((failure) => failure.includes("KPC"))).toBe(true);
  });

  it("fails on visibility regression and low precision", () => {
    const result = evaluateUtilityGate({
      visibilityDelta: -0.02,
      keypointCoverage: cleanCoverage,
      citationQuality: { precision: 0.5, recall: 0.9, citedClaims: 9, totalClaims: 10, weakClaims: [] }
    });
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("reports skipped checks instead of silently passing them", () => {
    const result = evaluateUtilityGate({ visibilityDelta: 0.01 });
    expect(result.pass).toBe(true);
    expect(result.skippedChecks).toEqual(["keypointCoverage", "citationQuality"]);
  });

  it("fails (not skips) citation quality when every citation is hallucinated", () => {
    const score = scoreCitationQuality(
      [{ claimId: 1, claim: "Fabricated citation.", sourceIndices: [9] }],
      new Map()
    );
    const result = evaluateUtilityGate({ visibilityDelta: 0.05, citationQuality: score });
    expect(result.pass).toBe(false);
    expect(result.skippedChecks).not.toContain("citationQuality");
    expect(result.failures.some((failure) => failure.includes("citation precision"))).toBe(true);
  });

  it("exposes AutoGEO-derived default thresholds", () => {
    expect(DEFAULT_UTILITY_GATE_THRESHOLDS.maxKpc).toBe(0);
    expect(DEFAULT_UTILITY_GATE_THRESHOLDS.minKpr).toBe(0.8);
  });
});
