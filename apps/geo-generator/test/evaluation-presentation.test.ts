import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGeoQualityEvaluationText,
  formatProbeLlmPrompt,
  getEvaluationSuiteCopy
} from "../src/app/lib/evaluation-presentation";
import type { CitationProbeResult, GeoQualityEvaluation } from "../src/app/lib/python-agent-dtos";

const evaluation: GeoQualityEvaluation = {
  overallScore: 84,
  dimensions: [{
    id: "geo",
    label: "GEO",
    score: 84,
    criteria: "Structural evidence",
    summary: "A diagnostic finding remains.",
    evidence: ["Product and WebPage are linked."],
    improvements: ["Add a direct answer."]
  }],
  validationDetails: ["Description needs a source scope."],
  validationImprovements: ["Keep the source scope next to the claim."]
};

function probe(delta: number, query: string): CitationProbeResult {
  return {
    engineId: "simulated-search",
    queries: [{
      query,
      querySource: "template",
      vanilla: { wordpos: 0.3 },
      generated: { wordpos: 0.3 + delta },
      delta: { wordpos: delta }
    }],
    mean: {
      vanilla: { wordpos: 0.3 },
      generated: { wordpos: 0.3 + delta },
      delta: { wordpos: delta }
    },
    gate: { pass: true },
    warnings: []
  };
}

test("presentation copy renders flat and worse citation probe items without truncating report or prompt guidance", () => {
  const suite = getEvaluationSuiteCopy("en");
  const context = {
    productName: "Hydra Barrier Cream",
    contentSections: {
      productName: "Hydra Barrier Cream",
      description: "Barrier care with source-backed ceramide information.",
      quickFacts: "50 ml",
      benefits: "Supports hydration.",
      ingredients: "Ceramide",
      howToUse: "Apply after cleansing.",
      faq: "Can it be used daily?"
    }
  };

  assert.equal(
    suite.easyCitationItem("Can dry skin use it?"),
    '[Citation] Add sentences that directly answer "Can dry skin use it?".'
  );

  const flatPrompt = formatProbeLlmPrompt(context, probe(0, "Can dry skin use it?"), "en");
  assert.match(flatPrompt, /\[About the same · fix first\] "Can dry skin use it\?"/);
  assert.match(flatPrompt, /## Safety check/);
  assert.match(flatPrompt, /Starting with the questions marked "fix first"/);
  assert.match(flatPrompt, /## Current content sections/);

  const worsePrompt = formatProbeLlmPrompt(context, probe(-0.12, "Which ingredient supports hydration?"), "en");
  assert.match(worsePrompt, /\[Original wins · fix first\] "Which ingredient supports hydration\?"/);
  assert.match(worsePrompt, /The generated content was cited less than the original/);

  const report = formatGeoQualityEvaluationText("Hydra Barrier Cream", evaluation, "en");
  assert.match(report, /Criteria: Structural evidence/);
  assert.match(report, /Rationale:\n- Product and WebPage are linked\./);
  assert.match(report, /Validation and repair details/);
  assert.match(report, /Validation-based improvements:/);
});
