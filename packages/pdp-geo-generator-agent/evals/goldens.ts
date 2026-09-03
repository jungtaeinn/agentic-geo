import type { EvalProductId } from "./fixtures/products";

/**
 * Golden set for the deterministic RAG retrieval benchmark (roadmap item 1,
 * docs/rag-inference-maximization-paper-analysis_2026-07-31.md §5).
 *
 * Coverage: 2 brands (ExampleLuxe en-US, EXAMPLEDERMA ko-KR) x 5 generation targets
 * (faq / howToUse / productDescription / webPageDescription / schema) plus
 * claim-safety and locale probes.
 *
 * `expectedChunks` anchors name evidence that SHOULD be in the top-K retrieved
 * context for the target, expressed as document (+ optional heading fragment).
 * Anchors follow the corpus' own "Partial Update Query Planning" sections in
 * eeat_v1.md / cep_v1.md / geo-research_v3.md, so the benchmark measures the
 * corpus against its own routing contract.
 *
 * `expectedClaims` / `forbiddenClaims` are generation-tier checks (faithfulness).
 * They are only scored when a generated artifact is supplied to the scorer —
 * retrieval CI does not require an LLM.
 *
 * Brand best-practice overlays are anchored at document level throughout. The
 * overlay conversion split each brand's rules into field-scoped sections (tone,
 * description adjustments, clinical wording, FAQ patterns) alongside the
 * cross-field "Brand-Specific Best Practice Overlay" umbrella, and the agent
 * protects one slot per overlay *document* (selectProtectedRagCoverageChunks),
 * whichever of those sections ranks highest for the target. What these goldens
 * probe is that the matched brand's overlay reaches the target's context, not
 * which of its sections wins, so a heading anchor here would only measure
 * near-tied section scores.
 */

export type EvalTarget = "faq" | "howToUse" | "productDescription" | "webPageDescription" | "schema";

export interface ExpectedChunkAnchor {
  /** RAG document name as loaded by the profile (e.g. "eeat_v1.md", "brands/exampleluxe/best-practice_v2.md"). */
  document: string;
  /** Optional case-insensitive fragment matched against chunk title / headingPath. Omit for document-level anchors. */
  heading?: string;
}

export interface RagEvalGolden {
  id: string;
  productId: EvalProductId;
  locale: "en-US" | "ko-KR";
  market: "US" | "KR";
  target: EvalTarget;
  /** What this golden probes, for reports. */
  focus: string;
  expectedChunks: ExpectedChunkAnchor[];
  /** Strings that must appear in generated output for this target (generation tier). */
  expectedClaims: string[];
  /** Strings that must NOT appear in generated output (generation tier). */
  forbiddenClaims: string[];
}

const EXAMPLELUXE_BP = "brands/exampleluxe/best-practice_v2.md";
const EXAMPLELUXE_IDENTITY = "brands/exampleluxe/brand-identity_v1.md";
const EXAMPLEDERMA_BP = "brands/examplederma/best-practice_v2.md";
const EXAMPLEDERMA_IDENTITY = "brands/examplederma/brand-identity_v1.md";
const EXAMPLEDERMA_LOCALE = "brands/examplederma/locale-expression-guidelines_v2.md";
const EXAMPLELUXE_LOCALE = "brands/exampleluxe/locale-expression-guidelines_v2.md";
const CONTRACTS = "content-field-contracts_v1.md";
const EEAT = "eeat_v1.md";
const CEP = "cep_v1.md";
const GEO_RESEARCH = "geo-research_v3.md";
const SCHEMA_DOC = "schema-org-product_v2.md";
const EVIDENCE_CARDS = "evidence/geo-research-cards_v1.md";
const OFFICIAL_DOCS = "official-ai-search-platform-docs_v1.md";

const COMMON_FORBIDDEN = ["clinically proven", "guaranteed", "cure", "treats eczema", "의학적 효능", "치료", "완치"];

export const ragEvalGoldens: RagEvalGolden[] = [
  // --- ExampleLuxe Botanical Ginseng Rejuvenating Serum (en-US) ---
  {
    id: "CGRS-FAQ",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "faq",
    focus: "FAQ intent routing: customer experience + claim safety + CEP query intents",
    expectedChunks: [
      { document: EEAT, heading: "Experience" },
      { document: CEP, heading: "CEP Dimensions" },
      { document: SCHEMA_DOC }
    ],
    expectedClaims: ["Botanical Ginseng Rejuvenating Serum", "retinol"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "CGRS-HOWTO",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "howToUse",
    focus: "HowTo source-faithfulness rules reach the usage generation context",
    // Re-anchored in the Phase 2 canonicalization: the source-faithfulness
    // rules this golden probes (goal + direct action, one-instruction-one-step
    // cardinality, preserved order) now live only in the HowTo Contract, and
    // schema-org_v2 §6 keeps just the schema-side node-emission conditions.
    expectedChunks: [
      { document: EXAMPLELUXE_BP },
      { document: CONTRACTS, heading: "HowTo Contract" },
      { document: CEP, heading: "PDP Field Mapping" }
    ],
    expectedClaims: ["after toner"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "CGRS-PDESC",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "productDescription",
    focus: "Product.description reasoning arc: causal path + claim safety + GEO principles",
    expectedChunks: [
      { document: CEP, heading: "Causal Path Completeness" },
      { document: EEAT, heading: "Trust-First Claim Safety" },
      { document: GEO_RESEARCH, heading: "Research-Backed GEO Principles" },
      { document: EXAMPLELUXE_BP }
    ],
    expectedClaims: ["Korean Ginseng", "fine lines", "firmness"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "CGRS-WDESC",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "webPageDescription",
    focus: "WebPage vs Product description separation contract",
    // Re-anchored twice in the Phase 2 canonicalization. First: the separation
    // contract this golden names by focus moved out of schema-org_v2 §4 into
    // the contract canon (§4 now carries only schema-side graph-integrity
    // rules, which the schema-target goldens already probe). Then to document
    // level, once the contracts document got its own kind: the coverage slot
    // reserves one chunk per kind, and for a page-description query the
    // Composition and Separation sections tie within ~0.018 with Composition
    // ahead on lexical mass, so a heading anchor here measures which section
    // won the slot rather than whether the contract reached the context. The
    // separation rules still arrive — field-contracts is a hydration family, so
    // generation receives the whole document, and its critical rules inject
    // first under the policy budget. CGRS-HOWTO keeps its heading anchor
    // because the HowTo Contract wins its target's slot outright.
    //
    // What this anchor move is worth, measured: scoring current retrieval
    // against the pre-move anchors puts webPageDescription claim recall at
    // 0.708 rather than 1.000 (-0.292, ~6x the 0.05 gate), and this golden is
    // the larger half of it at 0.333. The gate passes on the moved anchors, not
    // in spite of them, so read that 1.000 as "the contracts and CEP documents
    // reach this target", never as "retrieval is unchanged here".
    expectedChunks: [
      { document: EXAMPLELUXE_BP },
      { document: CONTRACTS },
      { document: CEP }
    ],
    expectedClaims: ["ExampleLuxe"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "CGRS-SCHEMA",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "schema",
    focus: "Schema eligibility + official platform constraints",
    expectedChunks: [
      { document: SCHEMA_DOC },
      { document: OFFICIAL_DOCS },
      { document: EEAT, heading: "Authoritativeness" }
    ],
    expectedClaims: ["@graph"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "CGRS-EVIDENCE",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    target: "productDescription",
    focus: "Clinical metric handling: evidence hierarchy + distilled research cards",
    expectedChunks: [
      { document: EEAT, heading: "Evidence Hierarchy" },
      { document: EVIDENCE_CARDS }
    ],
    expectedClaims: ["6 weeks"],
    forbiddenClaims: COMMON_FORBIDDEN
  },

  // --- ExampleLuxe Essential Activating Serum (en-US) ---
  {
    id: "FCAS-FAQ",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "faq",
    focus: "FAQ eligibility with zero source FAQ evidence (no-quota rule must surface)",
    expectedChunks: [
      { document: SCHEMA_DOC },
      { document: EEAT, heading: "Experience" },
      { document: CEP, heading: "CEP Dimensions" }
    ],
    expectedClaims: ["Essential Care Activating Serum"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "FCAS-HOWTO",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "howToUse",
    focus: "Single source instruction -> single HowTo step cardinality",
    expectedChunks: [
      { document: EXAMPLELUXE_BP },
      { document: SCHEMA_DOC }
    ],
    expectedClaims: ["first step", "after cleansing"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "FCAS-PDESC",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "productDescription",
    focus: "Multi-benefit product: causal completeness without overclaiming",
    expectedChunks: [
      { document: CEP, heading: "Causal Path Completeness" },
      { document: GEO_RESEARCH, heading: "Research-Backed GEO Principles" },
      { document: EXAMPLELUXE_BP }
    ],
    expectedClaims: ["500-Hour Aged Ginseng", "fine lines"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "FCAS-CLAIMSAFETY",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "productDescription",
    focus: "Trust-sensitive marketing claim (Korea's number one) must trigger claim-safety context",
    expectedChunks: [
      { document: EEAT, heading: "Trust-First Claim Safety" },
      { document: EXAMPLELUXE_LOCALE }
    ],
    expectedClaims: [],
    forbiddenClaims: [...COMMON_FORBIDDEN, "number one", "best serum"]
  },
  {
    id: "FCAS-SCHEMA",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "schema",
    focus: "Variant/offer markup for a multi-size product",
    expectedChunks: [
      { document: SCHEMA_DOC },
      { document: OFFICIAL_DOCS }
    ],
    expectedClaims: ["60 mL", "90 mL"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "FCAS-WDESC",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    target: "webPageDescription",
    focus: "Page-scope copy separation with clinical evidence in the source",
    expectedChunks: [
      { document: EXAMPLELUXE_BP },
      { document: CEP }
    ],
    expectedClaims: ["ExampleLuxe"],
    forbiddenClaims: COMMON_FORBIDDEN
  },

  // --- EXAMPLEDERMA 모이베리어365 캡슐 토너 (ko-KR) ---
  {
    id: "TONER-FAQ",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "faq",
    focus: "Real source FAQ (4 items): answer-ready FAQ + review/customer intent routing in Korean",
    expectedChunks: [
      { document: EEAT, heading: "Experience" },
      { document: SCHEMA_DOC },
      { document: EXAMPLEDERMA_BP }
    ],
    expectedClaims: ["세라마이드", "논코메도제닉"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "TONER-HOWTO",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "howToUse",
    focus: "Korean usage instruction -> HowTo step with locale phrasing",
    expectedChunks: [
      { document: EXAMPLEDERMA_BP },
      { document: SCHEMA_DOC }
    ],
    expectedClaims: ["세안 후"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "TONER-PDESC",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "productDescription",
    focus: "Barrier-care causal path: ceramide capsule -> barrier reinforcement (patented tech claim scope)",
    expectedChunks: [
      { document: CEP, heading: "Causal Path Completeness" },
      { document: EXAMPLEDERMA_BP },
      { document: EEAT, heading: "Trust-First Claim Safety" }
    ],
    expectedClaims: ["피부장벽", "고밀도 세라마이드 캡슐"],
    forbiddenClaims: [...COMMON_FORBIDDEN, "아토피 치료"]
  },
  {
    id: "TONER-LOCALE",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "productDescription",
    focus: "Korean locale expression guidance is retrieved for ko-KR generation",
    expectedChunks: [
      { document: EXAMPLEDERMA_LOCALE },
      { document: EXAMPLEDERMA_IDENTITY }
    ],
    expectedClaims: ["보습"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "TONER-SCHEMA",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "schema",
    focus: "FAQPage markup from real Q/A evidence",
    expectedChunks: [
      { document: SCHEMA_DOC },
      { document: OFFICIAL_DOCS }
    ],
    expectedClaims: ["FAQPage"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "TONER-WDESC",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    target: "webPageDescription",
    focus: "Korean page-scope description separation",
    // CEP anchored at document level (was "PDP Field Mapping"). Once the query
    // builder stopped restating the description stage order, cep §5.1 no longer
    // won its document's slot for this target — §3.2 Situation/Occasion does,
    // and the CEP-native sections sit within ~0.008 of each other, so the
    // heading anchor measured which section won rather than whether CEP
    // reached the target. Cost of the move, measured: this golden scores 0.5
    // against the old anchor, and with CGRS-WDESC it accounts for the whole
    // webPageDescription gap (1.000 -> 0.708) that the moved anchors close.
    // FCAS-WDESC and MIST-WDESC carry the same move but score 1.000 either way.
    expectedChunks: [
      { document: EXAMPLEDERMA_BP },
      { document: CEP }
    ],
    expectedClaims: ["예시더마"],
    forbiddenClaims: COMMON_FORBIDDEN
  },

  // --- EXAMPLEDERMA 모이베리어 365 크림 미스트 (ko-KR) ---
  {
    id: "MIST-FAQ",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "faq",
    focus: "Review-rich product: review-intent FAQ from repeated positive keywords",
    expectedChunks: [
      { document: EEAT, heading: "Experience" },
      { document: CEP, heading: "CEP Dimensions" },
      { document: EXAMPLEDERMA_BP }
    ],
    expectedClaims: ["크림 미스트"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "MIST-HOWTO",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "howToUse",
    focus: "Two distinct source routines -> ordered steps without merging",
    expectedChunks: [
      { document: EXAMPLEDERMA_BP },
      { document: SCHEMA_DOC }
    ],
    expectedClaims: ["세안 직후", "수시로"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "MIST-PDESC",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "productDescription",
    focus: "10,000ppm ceramide metric binding + attributed review keywords last",
    expectedChunks: [
      { document: CEP, heading: "Causal Path Completeness" },
      { document: EEAT, heading: "Trust-First Claim Safety" },
      { document: EXAMPLEDERMA_BP }
    ],
    expectedClaims: ["10,000ppm", "세라마이드"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "MIST-REVIEW",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "faq",
    focus: "Review evidence handling: 1,482 reviews / 4.9 rating must stay attributed, not efficacy proof",
    expectedChunks: [
      { document: EEAT, heading: "Experience" },
      { document: EEAT, heading: "Trust-First Claim Safety" }
    ],
    expectedClaims: [],
    forbiddenClaims: [...COMMON_FORBIDDEN, "모든 피부에 안전"]
  },
  {
    id: "MIST-SCHEMA",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "schema",
    focus: "additionalProperty benefit routing from review-backed points",
    expectedChunks: [
      { document: SCHEMA_DOC },
      { document: OFFICIAL_DOCS }
    ],
    expectedClaims: ["additionalProperty"],
    forbiddenClaims: COMMON_FORBIDDEN
  },
  {
    id: "MIST-WDESC",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    target: "webPageDescription",
    focus: "Korean page-scope description for a review-rich PDP",
    expectedChunks: [
      { document: EXAMPLEDERMA_BP },
      { document: CEP }
    ],
    expectedClaims: ["예시더마"],
    forbiddenClaims: COMMON_FORBIDDEN
  }
];
