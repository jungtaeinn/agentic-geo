/**
 * Structural input contracts for the PDP GEO evaluation agent.
 *
 * This package deliberately imports NOTHING from the extractor or generator
 * packages. Inputs are declared as the minimal structural subset the
 * evaluators actually read; TypeScript's structural typing lets apps pass
 * generator/extractor outputs directly (the monorepo's established wiring
 * pattern — packages stay independent, apps connect them).
 *
 * Consequence: hand-written markup, CMS output, or competitor pages can be
 * evaluated too — anything matching these shapes, not only generator runs.
 */

/** One atomic product evidence item (structural subset of the generator's ledger entry). */
export interface EvalEvidenceItem {
  id: string;
  role: string;
  text: string;
}

/** Flattened public content sections (structural twin of the generator's sections). */
export interface EvalContentSections {
  productName: string;
  description: string;
  quickFacts: string;
  benefits: string;
  ingredients: string;
  howToUse: string;
  faq: string;
}

/** Content-plan subset used for probe query derivation and plan-parity checks. */
export interface EvalContentPlanInput {
  mode?: string;
  productDescription?: { include: boolean; evidenceIds: string[] };
  webPageDescription?: { include: boolean; evidenceIds: string[] };
  faq: Array<{
    include: boolean;
    question: string;
    evidenceIds?: string[];
  }>;
  howTo?: {
    eligible: boolean;
    steps: Array<{ evidenceIds?: string[] }>;
  };
  cep: Array<{
    situation: string;
    need: string;
    constraint?: string;
    evidenceIds?: string[];
  }>;
}

/** Normalized product subset read by the quality rubric and source-text builders. */
export interface EvalNormalizedProduct {
  name?: string;
  brand?: string;
  category?: string;
  images?: unknown[];
  breadcrumbs?: Array<{ name?: string; url?: string }>;
  benefits?: string[];
  effects?: string[];
  ingredients?: string[];
  usage?: string[];
  faq?: Array<{ question: string; answer: string }>;
  reviews?: { keywords?: string[] };
  sourceTexts?: string[];
}

/** RAG usage subset for the E-E-A-T/CEP rubric signals. */
export interface EvalRagUsageItem {
  principle: string;
  enabled?: boolean;
  references: Array<{
    kind?: string;
    fieldTargets?: string[];
  }>;
}

export interface EvalEvidenceRecord {
  field: string;
  source: string;
  value: string;
}

export interface EvalValidationRepair {
  field: string;
  source?: string;
  issue?: string;
  action?: string;
}

/** Diagnostics subset consumed by the quality rubric (all optional beyond the core). */
export interface EvalDiagnosticsInput {
  normalizedProduct: EvalNormalizedProduct;
  validationWarnings: string[];
  validationRepairs?: EvalValidationRepair[];
  ragUsage?: EvalRagUsageItem[];
  evidence?: EvalEvidenceRecord[];
  evidenceLedger?: EvalEvidenceItem[];
  contentPlan?: EvalContentPlanInput;
}

/** Full quality-rubric input: the JSON-LD graph plus optional diagnostics context. */
export interface GeoQualityEvalInput {
  jsonLd: unknown;
  diagnostics: EvalDiagnosticsInput;
}

export type EvalUiLanguage = "ko" | "en";
