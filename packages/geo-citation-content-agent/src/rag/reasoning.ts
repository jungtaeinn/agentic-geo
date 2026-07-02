import type {
  GeoCitationContentAngle,
  GeoCitationContentBrief,
  GeoCitationNormalizedProduct,
  GeoCitationRetrievedChunk
} from "../types";

export interface GeoCitationReasoningResult {
  queryTerms: string[];
  principles: string[];
  selectedEvidenceTypes: string[];
}

export function createGeoCitationReasoning(input: {
  product: GeoCitationNormalizedProduct;
  angle: GeoCitationContentAngle;
  retrievedChunks: GeoCitationRetrievedChunk[];
  brief?: GeoCitationContentBrief;
}): GeoCitationReasoningResult {
  const queryTerms = [
    input.product.name,
    input.product.category,
    ...input.product.benefits,
    ...input.product.reviewKeywords
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    queryTerms: unique(queryTerms).slice(0, 12),
    principles: [
      "mandatory citation contract",
      "claim-to-evidence linking",
      "reddit community-fit tone",
      `${input.angle} content angle`
    ],
    selectedEvidenceTypes: unique(input.retrievedChunks.map((chunk) => chunk.sourceType))
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
