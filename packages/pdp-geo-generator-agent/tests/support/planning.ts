/**
 * Shared builders for content-planning inputs.
 *
 * `planningRequest` and `planPayload` were each declared three times. The
 * `planPayload` copies differed only in whether the locale was a parameter and
 * in the default `omitReason` ("not requested" vs "insufficient evidence") — a
 * difference no assertion reads, verified before merging them, but one that
 * would have silently diverged further.
 */
import { createPdpGeoEvidenceLedger } from "../../src/content-planner";
import type {
  PdpGeoContentPlan,
  PdpGeoContentPlanningRequest,
  PdpGeoLocale,
  PdpProductSignal
} from "../../src/types";

/**
 * A planning request carrying the product's own ledger. Pass `overrides` for
 * the cases that supply RAG chunks or a pre-built ledger instead.
 */
export function planningRequest(
  product: PdpProductSignal,
  locale: PdpGeoLocale = "ko-KR",
  overrides: Partial<PdpGeoContentPlanningRequest> = {}
): PdpGeoContentPlanningRequest {
  return {
    product,
    locale,
    evidenceLedger: createPdpGeoEvidenceLedger(product, locale),
    ragChunks: [],
    ...overrides
  };
}

/**
 * An empty plan in the shape a provider returns, for tests that assert what
 * the sanitizer does with a specific field. Everything is excluded by default
 * so each test states only the field it is about.
 */
export function planPayload(
  overrides: Partial<Omit<PdpGeoContentPlan, "mode">> = {}
): Omit<PdpGeoContentPlan, "mode"> {
  return {
    locale: "ko-KR",
    productDescription: {
      include: false,
      text: "",
      intent: "product-entity-summary",
      evidenceIds: [],
      confidence: 0,
      omitReason: "insufficient evidence"
    },
    webPageDescription: {
      include: false,
      text: "",
      intent: "page-coverage-summary",
      evidenceIds: [],
      confidence: 0,
      omitReason: "insufficient evidence"
    },
    faq: [],
    howTo: {
      eligible: false,
      ordered: false,
      goal: "",
      steps: [],
      evidenceIds: [],
      confidence: 0,
      omitReason: "not a procedure"
    },
    cep: [],
    warnings: [],
    ...overrides
  };
}
