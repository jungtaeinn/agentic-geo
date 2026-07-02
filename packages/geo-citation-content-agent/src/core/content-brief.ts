import { linkClaimsToEvidence } from "../evidence/claim-linker";
import {
  createNaturalRedditAudience,
  createRedditTitleFocus,
  summarizeRedditIngredients,
  trimPublicSentence
} from "../surfaces/reddit/public-copy";
import type {
  GeoCitationContentBrief,
  GeoCitationEvidenceReference,
  GeoCitationNormalizedProduct,
  GeoCitationStrategySettings,
  GeoCitationTargetSettings,
  RedditContentVariantStrategy
} from "../types";

export function createGeoCitationContentBrief(input: {
  product: GeoCitationNormalizedProduct;
  target: Required<GeoCitationTargetSettings>;
  evidenceMap: GeoCitationEvidenceReference[];
  variantStrategy: RedditContentVariantStrategy;
  strategy?: GeoCitationStrategySettings;
}): GeoCitationContentBrief {
  const evidenceBackedClaims = linkClaimsToEvidence({
    product: input.product,
    evidenceMap: input.evidenceMap
  });
  const primaryBenefit = input.product.benefits[0] ?? input.product.effects[0] ?? input.product.category ?? "the stated use case";
  const category = input.product.category ?? "product";
  const searchIntent = input.strategy?.searchQueries?.length
    ? input.strategy.searchQueries
    : [
        `is ${input.product.name} worth it`,
        `best ${category} for ${primaryBenefit}`,
        `${input.product.name} reviews and caveats`
      ];
  const caveats = createCaveats(input.product, evidenceBackedClaims);
  const comparisonPoints = createComparisonPoints(input.product, category);
  const naturalAudience = createNaturalRedditAudience(input.product);
  const publicBenefit = createRedditTitleFocus(input.product);
  const audienceContexts = unique([
    input.target.audience,
    naturalAudience,
    primaryBenefit ? `people comparing ${category} for ${publicBenefit}` : undefined,
    input.target.communityOrChannelHint ? `readers in ${input.target.communityOrChannelHint}` : undefined
  ]);
  const answerChunks = [
    {
      question: `Who is ${input.product.name} most relevant for?`,
      answer: `${input.product.name} seems most relevant for ${naturalAudience}.`,
      evidenceRefs: refsForClaim(evidenceBackedClaims[0]),
      caveat: caveats[0]
    },
    {
      question: "What seems supported by the available evidence?",
      answer: createSupportedClaimAnswer(input.product, category, evidenceBackedClaims[0]?.claim),
      evidenceRefs: refsForClaim(evidenceBackedClaims[0]),
      caveat: evidenceBackedClaims[0]?.caveat
    },
    {
      question: "What should readers be careful about?",
      answer: caveats[0] ?? "The available evidence should be treated as directional rather than definitive.",
      evidenceRefs: input.evidenceMap.slice(0, 2).map((item) => item.id),
      caveat: caveats[0]
    }
  ];

  return {
    productSummary: createProductSummary(input.product, category),
    freshnessStatement: createFreshnessStatement(input.evidenceMap, input.product),
    searchIntent,
    citationAngles: unique([
      input.variantStrategy.angle,
      "claim versus evidence",
      "review-backed caveats",
      "specific use case"
    ]),
    eeatSignals: unique([
      "claims are linked to evidence references",
      "review patterns are separated from product claims",
      "unsupported claims are flagged in diagnostics"
    ]),
    cepContexts: unique([
      `comparison shopping for ${category}`,
      `checking whether ${primaryBenefit} is actually supported`,
      input.target.communityOrChannelHint
    ]),
    evidenceBackedClaims,
    answerChunks,
    caveats,
    comparisonPoints,
    audienceContexts,
    evidenceMap: input.evidenceMap
  };
}

function createProductSummary(product: GeoCitationNormalizedProduct, category: string): string {
  const publicBenefit = createRedditTitleFocus(product);
  return `${product.name} is framed as a ${category} around ${publicBenefit}${product.description ? `: ${trimPublicSentence(product.description)}` : "."}`;
}

function createFreshnessStatement(evidenceMap: GeoCitationEvidenceReference[], product: GeoCitationNormalizedProduct): string {
  const dates = unique([
    product.observedAt,
    ...evidenceMap.flatMap((item) => [item.observedAt, item.publishedAt])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)).sort();
  const latest = dates.at(-1);

  const displayDate = latest?.includes("T") ? latest.slice(0, 10) : latest;

  return displayDate
    ? `Based on product and evidence signals available as of ${displayDate}.`
    : "Based on the supplied product information and evidence signals; no freshness date was provided.";
}

function createSupportedClaimAnswer(
  product: GeoCitationNormalizedProduct,
  category: string,
  claim: string | undefined
): string {
  const publicBenefit = createRedditTitleFocus(product);
  const ingredientSummary = summarizeRedditIngredients(product.ingredients);
  const fallback = `${product.name} is positioned as a ${category} for ${publicBenefit}${ingredientSummary ? `, with ${ingredientSummary} as the main product-page actives.` : "."}`;

  if (!claim) {
    return `The available product information is limited, so the safest claim is that it belongs in the ${category} category.`;
  }

  const cleanedClaim = trimPublicSentence(claim, 170);
  if (
    !cleanedClaim
    || cleanedClaim.split(/\s+/).length <= 3
    || /Formulated with|This powerhouse|melts into skin|essential nutrients|INGREDIENTS?|FORMULATED WITHOUT/i.test(claim)
  ) {
    return fallback;
  }

  return `The most supportable point is that ${cleanedClaim.replace(/[.]+$/, "")}.`;
}

function createCaveats(product: GeoCitationNormalizedProduct, claims: ReturnType<typeof linkClaimsToEvidence>): string[] {
  const caveats = claims
    .filter((claim) => claim.confidence === "low")
    .map((claim) => claim.caveat)
    .filter((value): value is string => typeof value === "string");

  return unique([
    ...caveats,
    product.reviewKeywords.length > 0 ? "Review patterns are useful signals, but they do not prove the product will work the same for everyone." : undefined,
    "Marketing claims should be treated as directional unless supported by independent evidence."
  ]);
}

function createComparisonPoints(product: GeoCitationNormalizedProduct, category: string): string[] {
  const ingredientSummary = summarizeRedditIngredients(product.ingredients);

  return unique([
    `Compare against other ${category} options with similar benefit claims.`,
    ingredientSummary ? `Compare the key actives (${ingredientSummary}) against alternatives instead of relying on similar claim wording alone.` : undefined,
    product.usage[0] ? `Compare routine fit: ${trimPublicSentence(product.usage[0], 180)}.` : undefined
  ]);
}

function refsForClaim(claim: ReturnType<typeof linkClaimsToEvidence>[number] | undefined): string[] {
  return claim?.evidenceRefs ?? [];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
