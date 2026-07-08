import type {
  GeoCitationEvidenceReference,
  GeoCitationNormalizedEvidence,
  GeoCitationRetrievedChunk
} from "../types";

export function createEvidenceMap(
  evidence: GeoCitationNormalizedEvidence[],
  selectedChunks: GeoCitationRetrievedChunk[]
): GeoCitationEvidenceReference[] {
  const selectedIds = new Set(selectedChunks.map((chunk) => chunk.evidenceId));
  const selectedEvidence = evidence.filter((item) => selectedIds.has(item.id));
  const fallbackEvidence = selectedEvidence.length > 0 ? selectedEvidence : evidence.slice(0, 4);

  return fallbackEvidence.map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    title: item.title,
    text: item.text,
    url: item.url,
    rating: item.rating,
    publishedAt: item.publishedAt,
    observedAt: item.observedAt
  }));
}
