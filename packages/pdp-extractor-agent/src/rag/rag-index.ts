import { productExtractorRagManifest } from "./manifest";
import type {
  ProductExtractorRagFieldTarget,
  ProductExtractorRagIntent,
  ProductExtractorRagKind
} from "./retrieval";

export type ProductExtractorRagSourceRole = "policy" | "official-reference" | "locale-map" | "custom";

export interface ProductExtractorRagSectionIndexEntry {
  heading: string;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
  priority?: number;
}

export interface ProductExtractorRagDocumentIndexEntry {
  document: string;
  version: string;
  kind: ProductExtractorRagKind;
  sourceRole: ProductExtractorRagSourceRole;
  checkedAt: string;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
  priority: number;
  sections: ProductExtractorRagSectionIndexEntry[];
}

export const productExtractorRagIndex: ProductExtractorRagDocumentIndexEntry[] = [
  {
    document: productExtractorRagManifest.analysisPrompt,
    version: "v1",
    kind: "analysis-prompt",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["orchestration", "evidence", "diagnostics"],
    fieldTargets: ["geoProduct", "diagnostics"],
    priority: 0.82,
    sections: [
      {
        heading: "RAG Orchestration",
        intents: ["orchestration", "diagnostics"],
        fieldTargets: ["diagnostics", "rag.chunks"],
        priority: 0.92
      },
      {
        heading: "Evidence Contract",
        intents: ["evidence", "diagnostics"],
        fieldTargets: ["geoProduct", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Field Mapping",
        intents: ["normalization", "classification"],
        fieldTargets: ["benefits", "effects", "ingredients", "usage"],
        priority: 0.86
      },
      {
        heading: "Exclusion Rules",
        intents: ["exclusion", "diagnostics"],
        fieldTargets: ["diagnostics"],
        priority: 0.94
      }
    ]
  },
  {
    document: productExtractorRagManifest.documents.productNormalization,
    version: "v1",
    kind: "product-normalization",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["normalization", "schema-ready", "evidence"],
    fieldTargets: ["geoProduct", "contentAnalysis.sections", "rag.chunks"],
    priority: 0.9,
    sections: [
      {
        heading: "Source Priority",
        intents: ["normalization", "evidence"],
        fieldTargets: ["geoProduct", "diagnostics"],
        priority: 0.86
      },
      {
        heading: "Field Rules",
        intents: ["normalization", "classification"],
        fieldTargets: ["benefits", "effects", "ingredients", "usage", "contentAnalysis.sections"],
        priority: 0.94
      },
      {
        heading: "Content Analysis Output",
        intents: ["schema-ready"],
        fieldTargets: ["contentAnalysis.sections", "rag.chunks"],
        priority: 0.88
      },
      {
        heading: "Exclusions and Diagnostics",
        intents: ["exclusion", "diagnostics"],
        fieldTargets: ["diagnostics", "geoProduct"],
        priority: 0.92
      }
    ]
  },
  {
    document: productExtractorRagManifest.documents.ocrKeywordClassification,
    version: "v1",
    kind: "ocr-classification",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["classification", "evidence", "exclusion"],
    fieldTargets: ["ocr.sentenceInsights", "benefits", "effects", "ingredients", "usage", "metrics", "diagnostics"],
    priority: 0.92,
    sections: [
      {
        heading: "Sentence Reconstruction",
        intents: ["classification", "evidence"],
        fieldTargets: ["ocr.sentenceInsights", "rag.chunks"],
        priority: 0.96
      },
      {
        heading: "Category Routing",
        intents: ["classification"],
        fieldTargets: ["benefits", "effects", "ingredients", "usage", "metrics"],
        priority: 0.94
      },
      {
        heading: "Exclusion Rules",
        intents: ["exclusion", "diagnostics"],
        fieldTargets: ["diagnostics"],
        priority: 0.96
      }
    ]
  },
  {
    document: productExtractorRagManifest.documents.reviewKeywordExtraction,
    version: "v1",
    kind: "review-extraction",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["review", "evidence"],
    fieldTargets: ["reviews", "diagnostics"],
    priority: 0.8,
    sections: [
      {
        heading: "Review Evidence",
        intents: ["review", "evidence"],
        fieldTargets: ["reviews"],
        priority: 0.9
      }
    ]
  },
  {
    document: productExtractorRagManifest.documents.faqExtraction,
    version: "v1",
    kind: "faq-extraction",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["faq", "evidence"],
    fieldTargets: ["faq", "rag.chunks"],
    priority: 0.8,
    sections: [
      {
        heading: "FAQ Evidence",
        intents: ["faq", "evidence"],
        fieldTargets: ["faq"],
        priority: 0.9
      }
    ]
  }
];

export function findProductExtractorRagIndexEntry(documentName: string): ProductExtractorRagDocumentIndexEntry | undefined {
  return productExtractorRagIndex.find((entry) => entry.document === documentName);
}

export function findProductExtractorRagSectionEntry(documentName: string, heading?: string): ProductExtractorRagSectionIndexEntry | undefined {
  const entry = findProductExtractorRagIndexEntry(documentName);
  if (!entry || !heading) {
    return undefined;
  }
  const normalizedHeading = normalizeHeading(heading);
  return entry.sections.find((section) => normalizedHeading.includes(normalizeHeading(section.heading)) || normalizeHeading(section.heading).includes(normalizedHeading));
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/g, " ").replace(/\s+/g, " ").trim();
}
