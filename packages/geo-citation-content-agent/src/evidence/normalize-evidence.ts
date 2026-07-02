import { classifyEvidenceSource } from "./source-classifier";
import type {
  GeoCitationEvidenceBuckets,
  GeoCitationEvidenceInput,
  GeoCitationEvidenceSourceType,
  GeoCitationNormalizedEvidence,
  GeoCitationNormalizedProduct,
  GeoCitationSourceInfo,
  JsonObject,
  JsonValue
} from "../types";

export function normalizeGeoCitationEvidence(input: {
  product: GeoCitationNormalizedProduct;
  evidence?: GeoCitationEvidenceBuckets;
  source?: GeoCitationSourceInfo;
}): GeoCitationNormalizedEvidence[] {
  const productEvidence = createProductEvidence(input.product, input.source);
  const bucketEvidence = [
    ...normalizeBucket(input.evidence?.reviews, "review", "review"),
    ...normalizeBucket(input.evidence?.images, "image", "image"),
    ...normalizeBucket(input.evidence?.newsArticles, "news", "news"),
    ...normalizeBucket(input.evidence?.researchPapers, "paper", "paper"),
    ...normalizeBucket(input.evidence?.existingGeoArtifacts, "existing-geo", "existing-geo"),
    ...normalizeBucket(input.evidence?.custom, "custom", "custom")
  ];

  return [...productEvidence, ...bucketEvidence].filter((item) => item.text.trim().length > 0);
}

function createProductEvidence(product: GeoCitationNormalizedProduct, source?: GeoCitationSourceInfo): GeoCitationNormalizedEvidence[] {
  const textParts = [
    product.description,
    product.benefits.length > 0 ? `Benefits: ${product.benefits.join(", ")}` : undefined,
    product.effects.length > 0 ? `Effects: ${product.effects.join(", ")}` : undefined,
    product.ingredients.length > 0 ? `Ingredients: ${product.ingredients.join(", ")}` : undefined,
    product.usage.length > 0 ? `Usage: ${product.usage.join(" ")}` : undefined,
    product.reviewKeywords.length > 0 ? `Review keywords: ${product.reviewKeywords.join(", ")}` : undefined
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return [
    {
      id: "product:profile",
      sourceType: "product",
      title: product.name,
      text: textParts.join("\n"),
      url: source?.url,
      observedAt: product.observedAt ?? source?.observedAt,
      freshness: source?.observedAt || product.observedAt ? "recent" : "unknown"
    }
  ];
}

function normalizeBucket(items: unknown[] | undefined, fallbackType: GeoCitationEvidenceSourceType, idPrefix: string): GeoCitationNormalizedEvidence[] {
  return (items ?? []).map((item, index) => normalizeEvidenceItem(item, fallbackType, `${idPrefix}:${index + 1}`));
}

function normalizeEvidenceItem(item: unknown, fallbackType: GeoCitationEvidenceSourceType, fallbackId: string): GeoCitationNormalizedEvidence {
  if (typeof item === "string") {
    return {
      id: fallbackId,
      sourceType: fallbackType,
      text: item,
      freshness: "unknown"
    };
  }

  const record = asRecord(item);
  const typed = record as Partial<GeoCitationEvidenceInput>;
  const sourceType = classifyEvidenceSource(asString(record.sourceType), fallbackType);
  const text = firstText([
    typed.text,
    record.body,
    record.content,
    record.summary,
    record.abstract,
    record.description,
    record.alt,
    record.ocrText,
    record.caption,
    record.html,
    record.markdown
  ]) ?? compactJson(record);

  return {
    id: typed.id ?? fallbackId,
    sourceType,
    title: typed.title ?? asString(record.name) ?? asString(record.headline),
    text,
    url: typed.url ?? asString(record.sourceUrl) ?? asString(record.link),
    author: typed.author ?? asString(record.reviewer) ?? asString(record.user),
    rating: typed.rating ?? asNumber(record.score),
    publishedAt: typed.publishedAt ?? asString(record.datePublished) ?? asString(record.date),
    observedAt: typed.observedAt ?? asString(record.observedAt),
    freshness: inferFreshness(typed.publishedAt ?? asString(record.datePublished) ?? asString(record.date), typed.observedAt ?? asString(record.observedAt)),
    metadata: typed.metadata ?? extractMetadata(record)
  };
}

function firstText(values: unknown[]): string | undefined {
  return values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .find((value) => value.length > 0);
}

function compactJson(record: Record<string, unknown>): string {
  return JSON.stringify(record, (_key, value: JsonValue | undefined) => value, 2).slice(0, 1200);
}

function inferFreshness(publishedAt?: string, observedAt?: string): GeoCitationNormalizedEvidence["freshness"] {
  if (observedAt) {
    return "recent";
  }

  if (!publishedAt) {
    return "unknown";
  }

  const timestamp = Date.parse(publishedAt);
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }

  const ageMs = Date.now() - timestamp;
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;

  return ageMs <= oneYearMs ? "recent" : "dated";
}

function extractMetadata(record: Record<string, unknown>): JsonObject | undefined {
  const metadata = asRecord(record.metadata);
  const entries = Object.entries(metadata).filter(([, value]) => isJsonValue(value));

  return entries.length > 0 ? Object.fromEntries(entries) as JsonObject : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }

  return false;
}
