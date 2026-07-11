import { pdpGeoGeneratorRagManifest } from "./manifest";
import type {
  PdpGeoRagFieldTarget,
  PdpGeoRagIntent,
  PdpGeoRagKind
} from "../types";

export type PdpGeoRagSourceRole = "policy" | "official-reference" | "research" | "locale-map" | "custom";

/**
 * "rules": list items are enforceable requirements for the policy checklist.
 * "narrative": list items are brand-story/positioning context; the policy
 * compiler demotes them to low-priority guidance so they cannot crowd out or
 * masquerade as hard constraints.
 */
export type PdpGeoRagRuleExtraction = "rules" | "narrative";

export interface PdpGeoRagSectionIndexEntry {
  heading: string;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  priority?: number;
  ruleExtraction?: PdpGeoRagRuleExtraction;
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
  ruleExtraction?: PdpGeoRagRuleExtraction;
  sections: PdpGeoRagSectionIndexEntry[];
}

export const pdpGeoRagIndex: PdpGeoRagDocumentIndexEntry[] = [
  {
    document: pdpGeoGeneratorRagManifest.analysisPrompt,
    version: "v1",
    kind: "orchestration",
    sourceRole: "policy",
    checkedAt: "2026-07-11",
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
    checkedAt: "2026-07-11",
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
    checkedAt: "2026-07-11",
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
    checkedAt: "2026-07-11",
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
    checkedAt: "2026-07-11",
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
    document: pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo,
    version: "v1",
    kind: "best-practice",
    sourceRole: "policy",
    checkedAt: "2026-07-11",
    intents: ["faq", "howTo", "claims", "review", "customer", "evidence", "schema"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics", "Product.additionalProperty", "Product.positiveNotes"],
    priority: 0.91,
    sections: [
      {
        heading: "Brand-Specific Best Practice Overlay",
        intents: ["customer", "claims", "evidence", "faq", "howTo"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
        priority: 0.96
      },
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
      },
      {
        heading: "Cross-Product Benchmarking Guidance",
        intents: ["review", "customer", "claims"],
        fieldTargets: ["PDP.content", "Product.description", "WebPage.description", "diagnostics"],
        priority: 0.88
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandBestPractices.aestura,
    version: "v1",
    kind: "best-practice",
    sourceRole: "policy",
    checkedAt: "2026-07-11",
    intents: ["faq", "howTo", "claims", "review", "customer", "evidence", "schema"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics", "Product.additionalProperty", "Product.positiveNotes"],
    priority: 0.91,
    sections: [
      {
        heading: "Brand-Specific Best Practice Overlay",
        intents: ["customer", "claims", "evidence", "faq", "howTo"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
        priority: 0.96
      },
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
      },
      {
        heading: "Cross-Product Benchmarking Guidance",
        intents: ["review", "customer", "claims"],
        fieldTargets: ["PDP.content", "Product.description", "WebPage.description", "diagnostics"],
        priority: 0.88
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo,
    version: "v1",
    kind: "custom",
    sourceRole: "custom",
    checkedAt: "2026-07-11",
    intents: ["customer", "schema", "review", "locale"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand Evidence Scope and RAG Use",
        intents: ["retrieval", "schema", "locale"],
        fieldTargets: ["diagnostics", "retrieval", "Product.description", "WebPage.description"],
        priority: 0.9
      },
      {
        heading: "Official Site-Derived Brand Identity Analysis",
        intents: ["customer", "schema", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.97
      },
      {
        heading: "Expected RAG Depth",
        intents: ["retrieval", "general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Identity Pillars",
        intents: ["customer", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.92,
        ruleExtraction: "narrative"
      },
      {
        heading: "GEO Projection Rules",
        intents: ["schema", "customer", "review", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "CEP and Customer Intent",
        intents: ["customer", "review", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Tone and Locale Guidance",
        intents: ["locale", "customer"],
        fieldTargets: ["PDP.content", "Product.description", "WebPage.description", "diagnostics"],
        priority: 0.86
      },
      {
        heading: "Claim Safety",
        intents: ["schema", "locale"],
        fieldTargets: ["diagnostics", "Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "Official Research and Innovation Sources",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Official Product-Line Articles",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Research Papers and Official Articles",
        intents: ["schema", "customer", "locale"],
        fieldTargets: ["diagnostics", "WebPage.description", "PDP.content"],
        priority: 0.96
      },
      {
        heading: "Source Notes",
        intents: ["general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandIdentities.aestura,
    version: "v1",
    kind: "custom",
    sourceRole: "custom",
    checkedAt: "2026-07-11",
    intents: ["customer", "schema", "review", "locale"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand Evidence Scope and RAG Use",
        intents: ["retrieval", "schema", "locale"],
        fieldTargets: ["diagnostics", "retrieval", "Product.description", "WebPage.description"],
        priority: 0.9
      },
      {
        heading: "Expected RAG Depth",
        intents: ["retrieval", "general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Core Brand Identity Statement",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics", "PDP.content"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Brand Narrative Architecture",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics", "PDP.content"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Official Korean Site Signals",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Official Site-Derived Brand Identity Analysis",
        intents: ["customer", "schema", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.97
      },
      {
        heading: "Market Source Prioritization and GEO Citation Strategy",
        intents: ["locale", "schema", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.98
      },
      {
        heading: "Identity Pillars",
        intents: ["customer", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.92,
        ruleExtraction: "narrative"
      },
      {
        heading: "GEO Projection Rules",
        intents: ["schema", "customer", "review", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "CEP and Customer Intent",
        intents: ["customer", "review", "locale"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Tone and Locale Guidance",
        intents: ["locale", "customer"],
        fieldTargets: ["PDP.content", "Product.description", "WebPage.description", "diagnostics"],
        priority: 0.86
      },
      {
        heading: "Claim Safety",
        intents: ["schema", "locale"],
        fieldTargets: ["diagnostics", "Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "Peer-Reviewed Research",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Official Research and Brand Sources",
        intents: ["customer", "locale"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      },
      {
        heading: "Research Papers and Official Articles",
        intents: ["schema", "customer", "locale"],
        fieldTargets: ["diagnostics", "WebPage.description", "PDP.content"],
        priority: 0.96
      },
      {
        heading: "Source Notes",
        intents: ["general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6,
        ruleExtraction: "narrative"
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.geoResearch,
    version: "v1",
    kind: "geo-research",
    sourceRole: "research",
    checkedAt: "2026-07-11",
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
    checkedAt: "2026-07-11",
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
      },
      {
        heading: "OpenAI Product Feeds and ChatGPT Shopping",
        intents: ["schema", "evidence"],
        fieldTargets: ["Product.additionalProperty", "Product.description", "diagnostics"],
        priority: 0.94
      },
      {
        heading: "Bing, Copilot, and IndexNow",
        intents: ["schema", "retrieval"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.88
      },
      {
        heading: "AI Crawler and Bot Access Requirements",
        intents: ["retrieval", "evidence"],
        fieldTargets: ["diagnostics"],
        priority: 0.9
      },
      {
        heading: "llms.txt Status",
        intents: ["retrieval", "general"],
        fieldTargets: ["diagnostics"],
        priority: 0.82
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
    document: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo,
    version: "v1",
    kind: "locale",
    sourceRole: "policy",
    checkedAt: "2026-07-06",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand-Specific Locale Overlay",
        intents: ["locale", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
        priority: 0.94
      },
      {
        heading: "Base Locale Expression Model",
        intents: ["locale", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.82
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura,
    version: "v1",
    kind: "locale",
    sourceRole: "policy",
    checkedAt: "2026-07-06",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand-Specific Locale Overlay",
        intents: ["locale", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
        priority: 0.94
      },
      {
        heading: "Base Locale Expression Model",
        intents: ["locale", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.82
      }
    ]
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
  },
  {
    document: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo,
    version: "v1",
    kind: "terminology",
    sourceRole: "locale-map",
    checkedAt: "2026-07-06",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
    priority: 0.78,
    sections: []
  },
  {
    document: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura,
    version: "v1",
    kind: "terminology",
    sourceRole: "locale-map",
    checkedAt: "2026-07-06",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
    priority: 0.78,
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
