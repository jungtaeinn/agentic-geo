import type {
  GeoCitationClaimWithEvidence,
  GeoCitationEvidenceReference,
  GeoCitationNormalizedProduct
} from "../types";

export function linkClaimsToEvidence(input: {
  product: GeoCitationNormalizedProduct;
  evidenceMap: GeoCitationEvidenceReference[];
}): GeoCitationClaimWithEvidence[] {
  const rawClaims = unique([
    ...input.product.benefits,
    ...input.product.effects,
    ...input.product.ingredients.map((ingredient) => `${ingredient} is part of the product evidence`),
    input.product.description
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0));

  return rawClaims.slice(0, 8).map((claim) => {
    const refs = findEvidenceRefs(claim, input.evidenceMap);

    return {
      claim,
      evidenceRefs: refs,
      confidence: refs.length >= 2 ? "high" : refs.length === 1 ? "medium" : "low",
      caveat: refs.length > 0 ? undefined : "No direct supporting evidence was selected for this claim."
    };
  });
}

function findEvidenceRefs(claim: string, evidenceMap: GeoCitationEvidenceReference[]): string[] {
  const claimTerms = new Set(tokenize(claim));

  return evidenceMap
    .map((item) => {
      const evidenceTerms = new Set(tokenize(`${item.title ?? ""} ${item.text}`));
      const overlap = [...claimTerms].filter((term) => evidenceTerms.has(term)).length;

      return {
        id: item.id,
        overlap
      };
    })
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map((item) => item.id);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
