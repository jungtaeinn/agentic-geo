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
    // Canonical field-contract document. It owns its own kind because it is the
    // only document the others defer to: every section here ends with "if
    // another document restates or contradicts this contract, this document
    // takes precedence". Sharing "best-practice" cost it the shared coverage
    // slot in selectFinalRagChunks — best-practice_v1 and the brand overlays
    // reach a clamped 1.0 and take it, so the canonical contract sat at
    // candidate rank 21-24 on description targets and never reached generation
    // (measured 2026-08-27). It also leaked into the prompts' tone guidance,
    // which selects the first "best-practice" chunk, though line 5 of the
    // document says to read it as field contracts and not as style guidance.
    document: pdpGeoGeneratorRagManifest.documents.contentFieldContracts,
    version: "v1",
    kind: "field-contracts",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
    intents: ["schema", "claims", "evidence", "faq", "howTo", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics"],
    priority: 0.95,
    sections: [
      {
        heading: "Description Composition Contract",
        intents: ["claims", "evidence", "customer"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.98
      },
      {
        heading: "Description Separation Contract",
        intents: ["schema", "claims"],
        fieldTargets: ["WebPage.description", "Product.description"],
        priority: 0.97
      },
      {
        heading: "FAQ Contract",
        intents: ["faq", "customer", "evidence"],
        fieldTargets: ["FAQPage.mainEntity"],
        priority: 0.97
      },
      {
        heading: "HowTo Contract",
        intents: ["howTo", "schema"],
        fieldTargets: ["HowTo.step"],
        priority: 0.97
      },
      {
        heading: "Schema Safety Contract",
        intents: ["schema", "claims", "review"],
        fieldTargets: ["Product.additionalProperty", "Product.description"],
        priority: 0.97
      },
      {
        heading: "Public Wording Contract",
        // Governs every public field (descriptions, additionalProperty, FAQ
        // answers, HowTo steps), so it carries the customer/faq/howTo intents
        // as well as claims/schema.
        intents: ["claims", "customer", "schema", "faq", "howTo"],
        fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "FAQPage.mainEntity", "HowTo.step", "PDP.content"],
        priority: 0.98
      },
      {
        heading: "Evidence Routing Contract",
        intents: ["evidence", "claims", "review"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.97
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
    version: "v2",
    kind: "schema",
    sourceRole: "official-reference",
    checkedAt: "2026-07-30",
    intents: ["schema", "faq", "howTo", "evidence"],
    fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "FAQPage.mainEntity", "HowTo.step", "BreadcrumbList"],
    priority: 0.92,
    // Section headings must track schema-org-product_v2.md. v2 merged the v1
    // per-type sections (FAQPage/HowTo/BreadcrumbList) into one combined
    // section, and added graph/description/property/safety sections.
    sections: [
      {
        // Scope statements orient a reader and record provenance; they decide
        // nothing about any field. Left unindexed they inherit the document's
        // content targets and can win the family's one reserved coverage seat —
        // measured 2026-08-28: on a schema subquery both schema.org and the
        // official-docs corpus reached the prompt as "1. Purpose" alone, so the
        // two families that exist to supply markup rules supplied none. Routing
        // them to diagnostics frees the seat while keeping their rules in the
        // policy checklist (a retrieval-only target would drop those instead).
        heading: "Purpose",
        intents: ["general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6
      },      {
        heading: "Official Source Scope",
        intents: ["general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6
      },
      {
        heading: "Graph Composition",
        intents: ["schema"],
        fieldTargets: ["Product.description", "WebPage.description", "BreadcrumbList"],
        priority: 0.94
      },
      {
        heading: "WebPage and Product Descriptions",
        intents: ["schema", "evidence"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "Product Properties",
        intents: ["schema", "evidence", "claims"],
        fieldTargets: ["Product.additionalProperty", "Product.description"],
        priority: 0.94
      },
      {
        heading: "FAQPage, HowTo, and BreadcrumbList",
        intents: ["faq", "howTo", "schema"],
        fieldTargets: ["FAQPage.mainEntity", "HowTo.step", "BreadcrumbList"],
        priority: 0.96
      },
      {
        heading: "Public Safety",
        intents: ["claims", "schema"],
        fieldTargets: ["Product.description", "WebPage.description", "diagnostics"],
        priority: 0.9
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
    fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
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
        fieldTargets: ["FAQPage.mainEntity", "HowTo.step", "WebPage.description"],
        priority: 0.9
      },
      {
        heading: "Expertise",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "Product.additionalProperty"],
        priority: 0.93
      },
      {
        heading: "Authoritativeness",
        intents: ["schema", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "BreadcrumbList"],
        priority: 0.92
      },
      {
        heading: "GEO Application",
        intents: ["claims", "evidence", "schema", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.92
      },
      {
        heading: "Operator Checklist",
        intents: ["evidence", "general"],
        fieldTargets: ["diagnostics"],
        priority: 0.86
      },
      {
        heading: "Trust-First Claim Safety",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "Partial Update Query Planning",
        intents: ["retrieval"],
        // Retrieval-plane guidance: it decides which chunks to fetch for a
        // partial update, never what a public field should say. Registering it
        // against content fields let it win the document's coverage seat on a
        // description subquery and displace the rule the field actually needs.
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.92
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.documents.cep,
    version: "v1",
    kind: "cep",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
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
        fieldTargets: ["WebPage.description", "Product.description", "Product.additionalProperty", "FAQPage.mainEntity", "HowTo.step"],
        priority: 0.92
      },
      {
        heading: "Partial Update Query Planning",
        intents: ["retrieval"],
        // Retrieval-plane guidance: it decides which chunks to fetch for a
        // partial update, never what a public field should say. Registering it
        // against content fields let it win the document's coverage seat on a
        // description subquery and displace the rule the field actually needs.
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.92
      },
      {
        heading: "Skincare and Beauty Examples",
        intents: ["customer", "faq", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "FAQPage.mainEntity", "PDP.content"],
        priority: 0.86
      },
      {
        heading: "Locale Rules",
        intents: ["locale", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
        priority: 0.86
      },
      {
        heading: "Anti-Patterns",
        intents: ["claims", "evidence"],
        fieldTargets: ["Product.description", "WebPage.description", "FAQPage.mainEntity", "diagnostics"],
        priority: 0.9
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
        heading: "Core Principle",
        intents: ["claims", "evidence", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.94
      },
      {
        heading: "BestPractice Tone Transfer",
        intents: ["locale", "customer", "general"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.9
      },
      {
        heading: "Recommended JSON-LD Graph Shape",
        intents: ["schema"],
        fieldTargets: ["Product.description", "WebPage.description", "BreadcrumbList"],
        priority: 0.92
      },
      {
        heading: "Schema.org + GEO Description Direction",
        intents: ["schema", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "Product Entity Best Practice",
        intents: ["schema", "claims", "evidence"],
        fieldTargets: ["Product.description", "Product.additionalProperty"],
        priority: 0.93
      },
      {
        heading: "OCR Sentence Diagnostics and English RAG Use",
        intents: ["evidence", "claims", "locale"],
        fieldTargets: ["diagnostics", "Product.description", "PDP.content"],
        priority: 0.9
      },
      {
        heading: "Description Pattern",
        intents: ["claims", "customer", "schema"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.92
      },
      {
        heading: "FAQ Best Practice",
        intents: ["faq", "customer", "review", "schema"],
        fieldTargets: ["FAQPage.mainEntity"],
        priority: 0.94
      },
      {
        heading: "HowTo Best Practice",
        intents: ["howTo", "schema", "evidence"],
        fieldTargets: ["HowTo.step"],
        priority: 0.94
      },
      {
        heading: "Evidence Hierarchy",
        intents: ["evidence", "claims"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "diagnostics"],
        priority: 0.93
      },
      {
        heading: "Reference Pattern Template",
        intents: ["schema", "evidence", "general"],
        fieldTargets: ["Product.description", "WebPage.description", "diagnostics"],
        priority: 0.9
      },
      {
        heading: "Field Evidence Routing Pattern",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "Product.additionalProperty", "HowTo.step"],
        priority: 0.94
      },
      {
        heading: "Korean Reference Artifact Usage",
        intents: ["locale", "evidence", "general"],
        fieldTargets: ["Product.description", "PDP.content", "diagnostics"],
        priority: 0.88
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
    document: pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe,
    version: "v2",
    kind: "best-practice",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
    intents: ["faq", "howTo", "claims", "review", "customer", "evidence", "schema"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics", "Product.additionalProperty"],
    priority: 0.91,
    sections: [
      {
        heading: "Brand-Specific Best Practice Overlay",
        intents: ["customer", "claims", "evidence", "faq", "howTo"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "ExampleLuxe US BestPractice Tone",
        intents: ["customer", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.93
      },
      {
        heading: "ExampleLuxe Clinical Wording Boundaries",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "ExampleLuxe US FAQ Question Patterns",
        intents: ["faq", "customer", "locale"],
        fieldTargets: ["FAQPage.mainEntity"],
        priority: 0.94
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandBestPractices.examplederma,
    version: "v2",
    kind: "best-practice",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
    intents: ["faq", "howTo", "claims", "review", "customer", "evidence", "schema"],
    fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "PDP.content", "diagnostics", "Product.additionalProperty"],
    priority: 0.91,
    sections: [
      {
        heading: "Brand-Specific Best Practice Overlay",
        intents: ["customer", "claims", "evidence", "faq", "howTo"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "EXAMPLEDERMA BestPractice Tone",
        intents: ["customer", "claims"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content"],
        priority: 0.93
      },
      {
        heading: "EXAMPLEDERMA Description Adjustments",
        intents: ["claims", "evidence", "schema"],
        fieldTargets: ["Product.description", "WebPage.description"],
        priority: 0.94
      },
      {
        heading: "EXAMPLEDERMA FAQ Question Patterns",
        intents: ["faq", "customer", "locale"],
        fieldTargets: ["FAQPage.mainEntity"],
        priority: 0.94
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe,
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
    document: pdpGeoGeneratorRagManifest.brandIdentities.examplederma,
    version: "v1",
    kind: "custom",
    sourceRole: "custom",
    checkedAt: "2026-08-27",
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
    version: "v3",
    kind: "geo-research",
    sourceRole: "research",
    checkedAt: "2026-07-30",
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
        intents: ["retrieval"],
        // Same reason as the Partial Update Query Planning sections above.
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.96
      },
      {
        heading: "PDP Field Guidance",
        intents: ["schema", "claims", "faq", "howTo", "customer"],
        fieldTargets: ["WebPage.description", "Product.description", "FAQPage.mainEntity", "HowTo.step", "Product.additionalProperty"],
        priority: 0.94
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
    // Offline-distilled evidence cards for the external research links in
    // the geo-research guidance document, which now defers the numbers and
    // provenance to them. Cards replace runtime URL resolution: each card is a
    // retrieval-ready chunk with provenance, publication status, and
    // field-scoped claims, so linked-paper evidence participates in retrieval
    // without fetching anything at generation time.
    document: pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards,
    version: "v1",
    kind: "evidence-cards",
    sourceRole: "research",
    checkedAt: "2026-07-30",
    intents: ["claims", "evidence", "retrieval", "schema", "customer", "faq"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "Product.additionalProperty", "diagnostics", "retrieval"],
    priority: 0.84,
    sections: [
      {
        heading: "Card Format and Usage",
        intents: ["retrieval", "general"],
        fieldTargets: ["retrieval", "diagnostics"],
        priority: 0.8,
        ruleExtraction: "narrative"
      },
      {
        heading: "Peer-Reviewed Evidence Cards",
        intents: ["claims", "evidence", "schema", "retrieval"],
        fieldTargets: ["Product.description", "WebPage.description", "Product.additionalProperty", "FAQPage.mainEntity", "diagnostics"],
        priority: 0.92
      },
      {
        heading: "Preprint and Emerging Evidence Cards",
        intents: ["claims", "evidence", "retrieval", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        priority: 0.84,
        ruleExtraction: "narrative"
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
        // Scope statements orient a reader and record provenance; they decide
        // nothing about any field. Left unindexed they inherit the document's
        // content targets and can win the family's one reserved coverage seat —
        // measured 2026-08-28: on a schema subquery both schema.org and the
        // official-docs corpus reached the prompt as "1. Purpose" alone, so the
        // two families that exist to supply markup rules supplied none. Routing
        // them to diagnostics frees the seat while keeping their rules in the
        // policy checklist (a retrieval-only target would drop those instead).
        heading: "Purpose",
        intents: ["general"],
        fieldTargets: ["diagnostics"],
        priority: 0.6
      },
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
    document: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe,
    version: "v2",
    kind: "locale",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand-Specific Locale Overlay",
        intents: ["locale", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
        priority: 0.94
      }
    ]
  },
  {
    document: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma,
    version: "v2",
    kind: "locale",
    sourceRole: "policy",
    checkedAt: "2026-08-27",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity", "HowTo.step"],
    priority: 0.8,
    sections: [
      {
        heading: "Brand-Specific Locale Overlay",
        intents: ["locale", "claims", "customer"],
        fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
        priority: 0.94
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
    document: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe,
    version: "v2",
    kind: "terminology",
    sourceRole: "locale-map",
    checkedAt: "2026-08-27",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
    priority: 0.78,
    sections: []
  },
  {
    document: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma,
    version: "v2",
    kind: "terminology",
    sourceRole: "locale-map",
    checkedAt: "2026-08-27",
    intents: ["locale", "claims", "customer"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "FAQPage.mainEntity"],
    priority: 0.78,
    sections: []
  }
];

export function findPdpGeoRagIndexEntry(documentName: string): PdpGeoRagDocumentIndexEntry | undefined {
  return pdpGeoRagIndex.find((entry) => entry.document === documentName);
}

/**
 * Resolves the routing entry for a chunk heading. When `headingPath` is given
 * (e.g. "GEO Research Guidance v3 > 3. Core Research Insights > 3.1 ..."),
 * segments are matched deepest-first so a subsection without its own index
 * entry inherits the metadata of its nearest indexed ancestor. This keeps the
 * section priorities/intents alive when documents evolve numbered subheadings
 * that the index only lists at the parent level.
 */
export function findPdpGeoRagSectionEntry(
  documentName: string,
  heading?: string,
  headingPath?: string
): PdpGeoRagSectionIndexEntry | undefined {
  const entry = findPdpGeoRagIndexEntry(documentName);
  if (!entry) {
    return undefined;
  }
  const candidates = [
    heading,
    ...(headingPath ? headingPath.split(">").map((segment) => segment.trim()).reverse() : [])
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    const normalizedHeading = normalizeHeading(candidate);
    if (!normalizedHeading) {
      continue;
    }
    const matched = entry.sections.find((section) =>
      normalizedHeading.includes(normalizeHeading(section.heading))
      || normalizeHeading(section.heading).includes(normalizedHeading));
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/g, " ").replace(/\s+/g, " ").trim();
}
