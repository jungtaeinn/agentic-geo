import { redditSurfaceProfile } from "./profile";
import { sanitizeRedditArtifactForPublicCopy } from "./public-copy";
import type { GeoCitationNormalizedProduct, RedditCitationArtifact } from "../../types";
import type { SurfaceValidationResult } from "../types";

const caveatPattern = /\b(caveat|careful|skeptical|limitation|uncertain|directional|not definitive|not a guarantee|not guarantee|not guaranteed|do not prove|does not prove|not proof)\b|주의|한계|조심|불확실|단정/i;

export function validateRedditArtifact(input: {
  artifact: RedditCitationArtifact;
  product: GeoCitationNormalizedProduct;
}): SurfaceValidationResult {
  const warnings: string[] = [];
  const publicCopy = sanitizeRedditArtifactForPublicCopy({
    artifact: input.artifact,
    product: input.product
  });
  let artifact = publicCopy.artifact;
  warnings.push(...publicCopy.warnings);
  const promoMatches = redditSurfaceProfile.prohibitedPatterns.filter((pattern) => pattern.test(`${artifact.title}\n${artifact.bodyMarkdown}`));

  if (promoMatches.length > 0) {
    warnings.push("Direct sales CTA or promotional phrase was detected and repaired.");
    artifact = repairPromotionalLanguage(artifact);
  }

  if (!/[?？]/.test(artifact.title) && !/\bnoticed\b|\blooked\b|\bcompared\b/i.test(artifact.title)) {
    warnings.push("Reddit title should be a question, comparison, or research observation.");
  }

  if (!caveatPattern.test(artifact.bodyMarkdown)) {
    warnings.push("Reddit body should include a caveat, limitation, or careful wording.");
  }

  if (!artifact.bodyMarkdown.trim().endsWith("?")) {
    warnings.push("Reddit body should end with an open community question.");
  }

  const productMentions = countOccurrences(`${artifact.title}\n${artifact.bodyMarkdown}`, input.product.name);
  if (productMentions > 8) {
    warnings.push("Product name appears too often for a natural Reddit discussion.");
  }

  const promotionalToneScore = Math.min(1, (promoMatches.length * 0.35) + (productMentions > 8 ? 0.2 : 0));

  return {
    artifact,
    warnings,
    promotionalToneScore
  };
}

function repairPromotionalLanguage(artifact: RedditCitationArtifact): RedditCitationArtifact {
  const repairedBody = artifact.bodyMarkdown
    .split("\n")
    .filter((line) => !redditSurfaceProfile.prohibitedPatterns.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\b(shop now|buy now|limited offer|link in bio)\b/gi, "compare the evidence")
    .replace(/지금\s*구매|바로\s*구매|링크를\s*확인/gi, "근거를 비교");

  return {
    ...artifact,
    title: artifact.title.replace(/\b(shop now|buy now|limited offer)\b/gi, "").trim(),
    bodyMarkdown: repairedBody
  };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle.trim()) {
    return 0;
  }

  return text.toLowerCase().split(needle.toLowerCase()).length - 1;
}
