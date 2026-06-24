import { pdpGeoGeneratorRagManifest } from "./manifest";
import type {
  PdpGeoRagFieldTarget,
  PdpGeoRagIntent,
  PdpGeoRagKind
} from "../types";

export type PdpGeoRagSourceRole = "policy" | "official-reference" | "research" | "locale-map" | "custom";

export interface PdpGeoRagSectionIndexEntry {
  heading: string;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  priority?: number;
}

export interface PdpGeoRagDocumentIndexEntry {
  document: string;
  version: string;
  kind: PdpGeoRagKind;
  sourceRole: PdpGeoRagSourceRole;
  checkedAt: string;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  priority: number;
  sections: PdpGeoRagSectionIndexEntry[];
}

export const pdpGeoRagIndex: PdpGeoRagDocumentIndexEntry[] = [
  {
    document: pdpGeoGeneratorRagManifest.analysisPrompt,
    version: "v1",
    kind: "orchestration",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["schema", "evidence", "retrieval", "general"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
    priority: 0.84,
    sections: [
      {
        heading: "RAG Orchestration",
        intents: ["retrieval", "schema", "evidence"],
        fieldTargets: ["diagnostics", "retrieval"],
        priority: 0.94
      },
      {
        heading: "Source-Backed Rewriting",
        intents: ["claims", "evidence", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.9
      },
      {
        heading: "Entity Separation",
        intents: ["schema", "faq", "howTo"],
        fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.92
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
    version: "v1",
    kind: "schema",
    sourceRole: "official-reference",
    checkedAt: "2026-06-24",
    intents: ["schema", "faq", "howTo", "evidence"],
    fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "Product.positiveNotes", "FAQPage.mainEntity", "HowTo.step", "BreadcrumbList"],
    priority: 0.92,
    sections: [
      {
        heading: "FAQPage",
        intents: ["faq", "schema"],
        fieldTargets: ["FAQPage.mainEntity"],
        priority: 0.96
      },
      {
        heading: "HowTo",
        intents: ["howTo", "schema"],
        fieldTargets: ["HowTo.step"],
        priority: 0.96
      },
      {
        heading: "BreadcrumbList",
        intents: ["schema"],
        fieldTargets: ["BreadcrumbList"],
        priority: 0.86
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.eeat,
    version: "v1",
    kind: "eeat",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["evidence", "claims", "review", "faq", "howTo"],
    fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "Product.positiveNotes", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
    priority: 0.86,
    sections: [
      {
        heading: "Evidence Hierarchy",
        intents: ["evidence", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "Experience",
        intents: ["customer", "review", "faq", "howTo"],
        fieldTargets: ["FAQPage.mainEntity", "HowTo.step", "Product.positiveNotes", "WebPage.description"],
        priority: 0.9
      },
      {
        heading: "Trust-First Claim Safety",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "Product.positiveNotes", "Product.additionalProperty", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "Partial Update Query Planning",
        intents: ["retrieval", "faq", "howTo", "schema"],
        fieldTargets: ["retrieval", "FAQPage.mainEntity", "HowTo.step", "Product.description"],
        priority: 0.92
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.cep,
    version: "v1",
    kind: "cep",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["customer", "faq", "claims"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "PDP.content"],
    priority: 0.82,
    sections: [
      {
        heading: "CEP Dimensions",
        intents: ["customer", "claims", "faq"],
        fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "PDP.content"],
        priority: 0.9
      },
      {
        heading: "CEP Identification and Prioritization",
        intents: ["customer", "review", "claims", "retrieval"],
        fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "PDP Field Mapping",
        intents: ["schema", "faq", "howTo", "customer"],
        fieldTargets: ["WebPage.description", "Product.description", "Product.additionalProperty", "Product.positiveNotes", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.92
      },
      {
        heading: "Partial Update Query Planning",
        intents: ["retrieval", "faq", "howTo", "schema"],
        fieldTargets: ["retrieval", "FAQPage.mainEntity", "HowTo.step", "Product.description"],
        priority: 0.92
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.bestPractice,
    version: "v1",
    kind: "best-practice",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["faq", "howTo", "claims", "review", "customer", "evidence"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics"],
    priority: 0.9,
    sections: [
      {
        heading: "RAG Corpus Orchestration",
        intents: ["retrieval", "general"],
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Public Wording Guardrails",
        intents: ["claims", "evidence"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.92
      },
      {
        heading: "Entity and Intent Rules",
        intents: ["faq", "howTo", "schema"],
        fieldTargets: ["FAQPage.mainEntity", "HowTo.step", "Product.description", "WebPage.description"],
        priority: 0.94
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.geoResearch,
    version: "v1",
    kind: "geo-research",
    sourceRole: "research",
    checkedAt: "2026-06-24",
    intents: ["claims", "customer", "evidence", "retrieval", "schema", "faq", "howTo", "review"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step", "Product.additionalProperty", "diagnostics", "retrieval"],
    priority: 0.82,
    sections: [
      {
        heading: "Core Research Insights",
        intents: ["claims", "evidence", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Research-Backed GEO Principles",
        intents: ["claims", "evidence", "review", "faq", "howTo", "schema"],
        fieldTargets: ["Product.description", "WebPage.description", "FAQPage.mainEntity", "HowTo.step", "Product.additionalProperty", "PDP.content"],
        priority: 0.94
      },
      {
        heading: "Retrieval and Query Planning",
        intents: ["retrieval", "faq", "howTo", "schema"],
        fieldTargets: ["retrieval", "FAQPage.mainEntity", "HowTo.step", "Product.description", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "Evaluation Checklist",
        intents: ["evidence", "schema", "claims"],
        fieldTargets: ["diagnostics", "Product.description", "WebPage.description", "PDP.content"],
        priority: 0.88
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
    version: "v1",
    kind: "official-docs",
    sourceRole: "official-reference",
    checkedAt: "2026-06-24",
    intents: ["retrieval", "schema", "evidence"],
    fieldTargets: ["retrieval", "Product.description", "Product.additionalProperty", "diagnostics"],
    priority: 0.84,
    sections: [
      {
        heading: "OpenAI Retrieval and Embeddings",
        intents: ["retrieval"],
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "Google Search Central Structured Data",
        intents: ["schema", "evidence"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.92
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
    version: "v1",
    kind: "locale",
    sourceRole: "policy",
    checkedAt: "2026-06-24",
    intents: ["locale", "claims"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
    priority: 0.78,
    sections: []
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
    version: "v1",
    kind: "terminology",
    sourceRole: "locale-map",
    checkedAt: "2026-06-24",
    intents: ["locale"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
    priority: 0.76,
    sections: []
  }
];

export function findPdpGeoRagIndexEntry(documentName: string): PdpGeoRagDocumentIndexEntry | undefined {
  return pdpGeoRagIndex.find((entry) => entry.document === documentName);
}

export function findPdpGeoRagSectionEntry(documentName: string, heading?: string): PdpGeoRagSectionIndexEntry | undefined {
  const entry = findPdpGeoRagIndexEntry(documentName);
  if (!entry || !heading) {
    return undefined;
  }
  const normalizedHeading = normalizeHeading(heading);
  return entry.sections.find((section) => normalizedHeading.includes(normalizeHeading(section.heading)) || normalizeHeading(section.heading).includes(normalizedHeading));
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/g, " ").replace(/\s+/g, " ").trim();
}
