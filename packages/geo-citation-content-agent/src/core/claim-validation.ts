import type {
  GeoCitationContentBrief,
  RedditCitationArtifact
} from "../types";

const unsafeClaimPatterns = [
  /\bcure[s|d]?\b/i,
  /\btreat[s|ed|ment]?\b/i,
  /\bguaranteed\b/i,
  /\bmiracle\b/i,
  /\bclinically proven\b/i,
  /완치|치료|보장|기적|무조건|100%/
];

export function validateClaimsAgainstEvidence(input: {
  artifact: RedditCitationArtifact;
  brief: GeoCitationContentBrief;
}): {
  unsupportedClaims: string[];
  warnings: string[];
} {
  const text = `${input.artifact.title}\n${input.artifact.bodyMarkdown}`;
  const unsupportedClaims = [
    ...unsafeClaimPatterns
      .filter((pattern) => pattern.test(text))
      .map((pattern) => `Potentially unsupported strong claim matched pattern: ${pattern.source}`),
    ...input.brief.evidenceBackedClaims
      .filter((claim) => claim.confidence === "low" && !claim.caveat)
      .map((claim) => `Claim has low evidence confidence: ${claim.claim}`)
  ];
  const warnings = input.brief.evidenceBackedClaims.some((claim) => claim.evidenceRefs.length === 0)
    ? ["Some product claims do not have selected evidence references."]
    : [];

  return {
    unsupportedClaims,
    warnings
  };
}
