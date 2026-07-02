import { chunkGeoCitationEvidence } from "../evidence/evidence-chunking";
import { createEvidenceMap } from "../evidence/evidence-map";
import { normalizeGeoCitationEvidence } from "../evidence/normalize-evidence";
import { retrieveGeoCitationEvidenceChunks } from "../rag/retrieval";
import type {
  GeoCitationEvidenceBuckets,
  GeoCitationEvidenceChunk,
  GeoCitationEvidenceReference,
  GeoCitationNormalizedEvidence,
  GeoCitationNormalizedProduct,
  GeoCitationRagSettings,
  GeoCitationRetrievedChunk,
  GeoCitationSourceInfo,
  GeoCitationStrategySettings
} from "../types";

export interface GeoCitationEvidencePipelineResult {
  evidence: GeoCitationNormalizedEvidence[];
  chunks: GeoCitationEvidenceChunk[];
  selectedChunks: GeoCitationRetrievedChunk[];
  evidenceMap: GeoCitationEvidenceReference[];
}

export function runGeoCitationEvidencePipeline(input: {
  product: GeoCitationNormalizedProduct;
  evidence?: GeoCitationEvidenceBuckets;
  source?: GeoCitationSourceInfo;
  strategy?: GeoCitationStrategySettings;
  rag?: GeoCitationRagSettings;
}): GeoCitationEvidencePipelineResult {
  const evidence = normalizeGeoCitationEvidence({
    product: input.product,
    evidence: input.evidence,
    source: input.source
  });
  const chunks = chunkGeoCitationEvidence(evidence);
  const selectedChunks = retrieveGeoCitationEvidenceChunks({
    product: input.product,
    chunks,
    strategy: input.strategy,
    settings: input.rag
  });
  const evidenceMap = createEvidenceMap(evidence, selectedChunks.length > 0 ? selectedChunks : chunks.slice(0, 6).map((chunk) => ({
    ...chunk,
    score: 0.05,
    reason: "fallback evidence chunk selected because retrieval produced no matches"
  })));

  return {
    evidence,
    chunks,
    selectedChunks,
    evidenceMap
  };
}
