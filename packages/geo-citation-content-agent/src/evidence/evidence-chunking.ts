import type { GeoCitationEvidenceChunk, GeoCitationNormalizedEvidence } from "../types";

export function chunkGeoCitationEvidence(evidence: GeoCitationNormalizedEvidence[]): GeoCitationEvidenceChunk[] {
  return evidence.flatMap((item) => splitEvidenceText(item).map((text, index) => ({
    id: `${item.id}:chunk:${index + 1}`,
    evidenceId: item.id,
    sourceType: item.sourceType,
    title: item.title,
    text,
    url: item.url,
    publishedAt: item.publishedAt,
    observedAt: item.observedAt,
    keywords: extractKeywords(`${item.title ?? ""} ${text}`)
  })));
}

function splitEvidenceText(item: GeoCitationNormalizedEvidence): string[] {
  const maxLength = 700;
  const normalized = item.text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const sentences = normalized.split(/(?<=[.!?。！？])\s+/u);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [normalized.slice(0, maxLength)];
}

function extractKeywords(text: string): string[] {
  const stopwords = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "제품", "상품", "그리고", "입니다"]);

  return [...new Set(text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !stopwords.has(word)))]
    .slice(0, 16);
}
