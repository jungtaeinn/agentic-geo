import type { GeoCitationEvidenceSourceType } from "../types";

export function classifyEvidenceSource(sourceType: string | undefined, fallback: GeoCitationEvidenceSourceType): GeoCitationEvidenceSourceType {
  switch (sourceType) {
    case "product":
    case "review":
    case "image":
    case "news":
    case "paper":
    case "existing-geo":
    case "custom":
      return sourceType;
    case "research":
    case "research-paper":
      return "paper";
    case "article":
    case "newsArticle":
      return "news";
    case "geo":
    case "pdp-geo":
      return "existing-geo";
    default:
      return fallback;
  }
}
