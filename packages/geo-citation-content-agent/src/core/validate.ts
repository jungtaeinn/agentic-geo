import { z } from "zod";
import { evaluateGeoCitationReadiness } from "./geo-readiness-validation";
import { validateClaimsAgainstEvidence } from "./claim-validation";
import { validateRedditArtifact } from "../surfaces/reddit/validate";
import type {
  GeoCitationContentBrief,
  GeoCitationContentInput,
  GeoCitationNormalizedProduct,
  GeoCitationReadinessReport,
  GeoCitationSurface,
  RedditCitationArtifact
} from "../types";

const surfaceSchema = z.enum(["reddit", "youtube", "blog"]);
const localeSchema = z.enum(["ko-KR", "ja-JP", "en-US", "en-GB"]);

const inputSchema = z.object({
  product: z.unknown(),
  source: z.object({
    type: z.enum(["pdp-extractor", "pdp-geo-generator", "rest-api", "manual-json", "unknown"]).optional(),
    url: z.string().optional(),
    apiName: z.string().optional(),
    observedAt: z.string().optional()
  }).optional(),
  evidence: z.object({
    reviews: z.array(z.unknown()).optional(),
    images: z.array(z.unknown()).optional(),
    newsArticles: z.array(z.unknown()).optional(),
    researchPapers: z.array(z.unknown()).optional(),
    existingGeoArtifacts: z.array(z.unknown()).optional(),
    custom: z.array(z.unknown()).optional()
  }).optional(),
  target: z.object({
    surface: surfaceSchema.default("reddit"),
    locale: localeSchema.optional(),
    market: z.string().optional(),
    audience: z.string().optional(),
    communityOrChannelHint: z.string().optional()
  }).optional(),
  strategy: z.object({
    searchQueries: z.array(z.string()).optional(),
    citationGoals: z.array(z.string()).optional(),
    contentAngle: z.enum(["claim-check", "comparison", "use-case-fit", "review-pattern", "skeptical-research", "buyer-question"]).optional(),
    avoidPromotionalTone: z.boolean().optional(),
    variants: z.object({
      count: z.number().int().positive().optional(),
      diversity: z.enum(["low", "medium", "high"]).optional(),
      avoidNearDuplicate: z.boolean().optional(),
      seed: z.string().optional()
    }).optional(),
    generationMode: z.enum(["single-best", "multi-candidate"]).optional()
  }).optional(),
  rag: z.object({
    mode: z.enum(["local-versioned-rag", "managed-vector-store-rag"]).optional(),
    maxChunks: z.number().int().positive().optional(),
    scoreThreshold: z.number().optional(),
    documents: z.array(z.object({
      name: z.string(),
      content: z.string(),
      version: z.string().optional(),
      sourceRole: z.enum(["mandatory-policy", "surface-guideline", "evidence", "custom"]).optional()
    })).optional(),
    analysisPrompt: z.string().optional()
  }).optional()
});

export function validateGeoCitationInput(input: GeoCitationContentInput): GeoCitationContentInput {
  return inputSchema.parse(input) as GeoCitationContentInput;
}

export function createDefaultTarget(target: GeoCitationContentInput["target"]): Required<NonNullable<GeoCitationContentInput["target"]>> {
  return {
    surface: (target?.surface ?? "reddit") as GeoCitationSurface,
    locale: target?.locale ?? "en-US",
    market: target?.market ?? "US",
    audience: target?.audience ?? "people comparing product claims and real-world evidence",
    communityOrChannelHint: target?.communityOrChannelHint ?? "a relevant Reddit community"
  };
}

export function validateAndRepairGeoCitationArtifact(input: {
  artifact: RedditCitationArtifact;
  brief: GeoCitationContentBrief;
  product: GeoCitationNormalizedProduct;
}): {
  artifact: RedditCitationArtifact;
  unsupportedClaims: string[];
  channelWarnings: string[];
  validationWarnings: string[];
  promotionalToneScore: number;
  geoCitationReadiness: GeoCitationReadinessReport;
} {
  const redditValidation = validateRedditArtifact({
    artifact: input.artifact,
    product: input.product
  });
  const claimValidation = validateClaimsAgainstEvidence({
    artifact: redditValidation.artifact,
    brief: input.brief
  });
  const geoCitationReadiness = evaluateGeoCitationReadiness({
    artifact: redditValidation.artifact,
    brief: input.brief,
    product: input.product
  });

  return {
    artifact: redditValidation.artifact,
    unsupportedClaims: claimValidation.unsupportedClaims,
    channelWarnings: redditValidation.warnings,
    validationWarnings: [
      ...claimValidation.warnings,
      ...geoCitationReadiness.warnings
    ],
    promotionalToneScore: redditValidation.promotionalToneScore,
    geoCitationReadiness
  };
}
