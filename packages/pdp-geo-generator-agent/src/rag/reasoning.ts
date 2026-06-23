import type {
  PdpGeoLocale,
  PdpGeoRagFieldTarget,
  PdpGeoRagIntent,
  PdpGeoReasoningDecision,
  PdpGeoReasoningPrinciple,
  PdpGeoReasoningResult,
  PdpGeoRetrievedChunk,
  PdpProductSignal
} from "../types";

interface CreatePdpGeoReasoningInput {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  ragChunks: PdpGeoRetrievedChunk[];
}

const queryIntents = [
  "schema and entity composition",
  "answer-ready FAQ intent",
  "stepwise HowTo reconstruction",
  "evidence-backed claim selection",
  "target customer and category-entry context",
  "customer review language",
  "locale terminology and public wording"
];

const crossCuttingRagKinds = ["eeat", "cep", "geo-research"] as const satisfies readonly PdpGeoRetrievedChunk["kind"][];

type RagRoutingKey = "faq" | "howTo" | "claims" | "customer" | "review";
type RagRoutingRule = {
  primaryIntents: PdpGeoRagIntent[];
  supportingIntents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  fallbackKinds: PdpGeoRetrievedChunk["kind"][];
};

const ragRoutingByPrinciple: Record<RagRoutingKey, RagRoutingRule> = {
  faq: {
    primaryIntents: ["faq"],
    supportingIntents: ["customer", "review", "claims", "evidence", "schema", "locale", "general"],
    fieldTargets: ["FAQPage.mainEntity"],
    fallbackKinds: [...crossCuttingRagKinds, "schema", "best-practice", "official-docs"]
  },
  howTo: {
    primaryIntents: ["howTo"],
    supportingIntents: ["evidence", "schema", "locale", "general"],
    fieldTargets: ["HowTo.step"],
    fallbackKinds: [...crossCuttingRagKinds, "schema", "best-practice"]
  },
  claims: {
    primaryIntents: ["claims", "evidence"],
    supportingIntents: ["schema", "locale", "general"],
    fieldTargets: ["Product.description", "Product.additionalProperty", "Product.positiveNotes"],
    fallbackKinds: [...crossCuttingRagKinds, "schema", "best-practice", "official-docs"]
  },
  customer: {
    primaryIntents: ["customer"],
    supportingIntents: ["faq", "review", "claims", "locale", "general"],
    fieldTargets: ["WebPage.description", "Product.description"],
    fallbackKinds: [...crossCuttingRagKinds, "best-practice", "locale"]
  },
  review: {
    primaryIntents: ["review"],
    supportingIntents: ["faq", "customer", "evidence", "schema", "locale", "general"],
    fieldTargets: ["FAQPage.mainEntity", "Product.description", "Product.positiveNotes"],
    fallbackKinds: [...crossCuttingRagKinds, "schema", "best-practice"]
  }
};

/** Builds an explicit reasoning plan from selected RAG chunks and product evidence. */
export function createPdpGeoReasoning(input: CreatePdpGeoReasoningInput): PdpGeoReasoningResult {
  const evidence = collectProductEvidence(input.product);
  const selectedSources = unique(input.ragChunks.map(formatRagSource)).slice(0, 12);
  const ragSourcesByPrinciple = {
    faq: sourcesForPrinciple(input.ragChunks, ragRoutingByPrinciple.faq),
    howTo: sourcesForPrinciple(input.ragChunks, ragRoutingByPrinciple.howTo),
    claims: sourcesForPrinciple(input.ragChunks, ragRoutingByPrinciple.claims),
    customer: sourcesForPrinciple(input.ragChunks, ragRoutingByPrinciple.customer),
    review: sourcesForPrinciple(input.ragChunks, ragRoutingByPrinciple.review)
  };

  const decisions: PdpGeoReasoningDecision[] = [
    createDecision({
      principle: "answer-ready FAQ",
      ragSources: ragSourcesByPrinciple.faq,
      productEvidence: [...evidence.benefits, ...evidence.ingredients, ...evidence.usage, ...evidence.faq, ...evidence.reviews].slice(0, 8),
      fallbackSources: selectedSources,
      rationale: "FAQ generation should be grounded in selected schema/GEO RAG guidance plus product benefit, ingredient, usage, FAQ, or review evidence."
    }),
    createDecision({
      principle: "stepwise HowTo",
      ragSources: ragSourcesByPrinciple.howTo,
      productEvidence: evidence.usage.slice(0, 6),
      fallbackSources: selectedSources,
      rationale: "HowTo reconstruction is enabled only when usage evidence exists and selected RAG guidance can support step-level composition."
    }),
    createDecision({
      principle: "evidence-backed claims",
      ragSources: ragSourcesByPrinciple.claims,
      productEvidence: [...evidence.sourceBackedClaims, ...evidence.effects, ...evidence.reviews].slice(0, 8),
      fallbackSources: selectedSources,
      rationale: "Claim wording should use selected trust/schema RAG guidance together with source-backed product claims, effects, or review evidence."
    }),
    createDecision({
      principle: "target customer context",
      ragSources: ragSourcesByPrinciple.customer,
      productEvidence: [input.product.category, ...evidence.benefits, ...evidence.sourceBackedClaims].filter((value): value is string => Boolean(value)).slice(0, 8),
      fallbackSources: selectedSources,
      rationale: "Target-customer context should be inferred from category, benefit, and source text evidence while selected RAG guidance supplies the composition rule."
    }),
    createDecision({
      principle: "review-intent FAQ",
      ragSources: ragSourcesByPrinciple.review,
      productEvidence: evidence.reviews.slice(0, 8),
      fallbackSources: selectedSources,
      rationale: "Review-led FAQ intent is enabled when customer review evidence is present and selected RAG guidance supports review language reuse."
    })
  ];
  const principles = decisions
    .filter((decision) => decision.enabled)
    .map((decision) => decision.principle);

  return {
    mode: "explicit-rag-product-reasoning",
    queryIntents,
    selectedSources,
    productEvidence: evidence,
    decisions,
    principles
  };
}

export function isPdpGeoReasoningEnabled(reasoning: PdpGeoReasoningResult, principle: PdpGeoReasoningPrinciple): boolean {
  return reasoning.decisions.some((decision) => decision.principle === principle && decision.enabled);
}

function createDecision(input: {
  principle: PdpGeoReasoningPrinciple;
  ragSources: string[];
  productEvidence: string[];
  fallbackSources: string[];
  rationale: string;
}): PdpGeoReasoningDecision {
  const ragSources = (input.ragSources.length > 0 ? input.ragSources : input.fallbackSources).slice(0, 6);
  const productEvidence = unique(input.productEvidence).slice(0, 8);
  const enabled = ragSources.length > 0 && productEvidence.length > 0;
  const confidence = enabled
    ? Math.min(0.95, 0.55 + Math.min(ragSources.length, 3) * 0.08 + Math.min(productEvidence.length, 5) * 0.04)
    : 0;

  return {
    principle: input.principle,
    enabled,
    confidence,
    ragSources,
    productEvidence,
    rationale: input.rationale
  };
}

function collectProductEvidence(product: PdpProductSignal): PdpGeoReasoningResult["productEvidence"] {
  return {
    benefits: unique(product.benefits).slice(0, 10),
    effects: unique(product.effects).slice(0, 10),
    ingredients: unique(product.ingredients).slice(0, 10),
    usage: unique(product.usage).slice(0, 8),
    reviews: unique([
      ...product.reviews.keywords,
      ...product.reviews.items.map((item) => item.body)
    ]).slice(0, 10),
    faq: unique(product.faq.map((item) => `Q: ${item.question}\nA: ${item.answer}`)).slice(0, 8),
    sourceBackedClaims: unique([
      product.description,
      ...product.metrics,
      ...product.sourceTexts
    ].filter((value): value is string => Boolean(value))).slice(0, 12)
  };
}

function sourcesForPrinciple(
  chunks: PdpGeoRetrievedChunk[],
  rule: RagRoutingRule
): string[] {
  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: principleChunkScore(chunk, rule)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.chunk.score - a.chunk.score)
    .map((item) => formatRagSource(item.chunk));

  return unique(scored).slice(0, 6);
}

function principleChunkScore(
  chunk: PdpGeoRetrievedChunk,
  rule: RagRoutingRule
): number {
  const intents = new Set(chunkIntents(chunk));
  const fieldTargets = new Set(chunkFieldTargets(chunk));
  const fallbackKindSet = new Set(rule.fallbackKinds);
  let score = 0;
  const hasRoutingMetadata = intents.size > 0 || fieldTargets.size > 0;

  if (rule.primaryIntents.some((intent) => intents.has(intent))) {
    score += 5;
  }
  if (rule.fieldTargets.some((target) => fieldTargets.has(target))) {
    score += 3;
  }
  if (rule.supportingIntents.some((intent) => intents.has(intent))) {
    score += 1.5;
  }
  if (fallbackKindSet.has(chunk.kind) && (!hasRoutingMetadata || score > 0)) {
    score += 0.75;
  }
  if (crossCuttingRagKinds.includes(chunk.kind as typeof crossCuttingRagKinds[number]) && intents.has("general")) {
    score += 1;
  }
  if (/reference output|verbatim|benchmark/i.test(`${chunk.title ?? ""} ${chunk.source}`)) {
    score -= 2;
  }

  return score;
}

function chunkIntents(chunk: PdpGeoRetrievedChunk): PdpGeoRagIntent[] {
  const values = chunk.intents?.length ? chunk.intents : parseMetadataList(chunk.metadata.sectionIntents);
  return values.filter(isPdpGeoRagIntent);
}

function chunkFieldTargets(chunk: PdpGeoRetrievedChunk): PdpGeoRagFieldTarget[] {
  const values = chunk.fieldTargets?.length ? chunk.fieldTargets : parseMetadataList(chunk.metadata.fieldTargets);
  return values.filter(isPdpGeoRagFieldTarget);
}

function parseMetadataList(value: string | number | boolean | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function formatRagSource(chunk: Pick<PdpGeoRetrievedChunk, "source" | "title">): string {
  return chunk.title ? `${chunk.source}#${chunk.title}` : chunk.source;
}

function isPdpGeoRagIntent(value: string): value is PdpGeoRagIntent {
  return ["faq", "howTo", "claims", "customer", "review", "schema", "locale", "evidence", "retrieval", "general"].includes(value);
}

function isPdpGeoRagFieldTarget(value: string): value is PdpGeoRagFieldTarget {
  return [
    "WebPage.description",
    "Product.description",
    "Product.additionalProperty",
    "Product.positiveNotes",
    "FAQPage.mainEntity",
    "HowTo.step",
    "BreadcrumbList",
    "PDP.content",
    "diagnostics",
    "retrieval"
  ].includes(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
