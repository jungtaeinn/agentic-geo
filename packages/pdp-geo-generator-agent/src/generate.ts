import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import { createPdpGeoReasoning, isPdpGeoReasoningEnabled } from "./rag/reasoning";
import { isConflictingProductUsageInstruction } from "./product-scope";
import { isNegativeReviewSignalText } from "./review-sentiment";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoContentPlan,
  PdpGeoContentSections,
  PdpGeoEvidence,
  PdpGeoFaqItem,
  PdpGeoGenerationHints,
  PdpGeoInferredSearchQueryDiagnostic,
  PdpGeoLocale,
  PdpGeoRecommendation,
  PdpGeoReasoningResult,
  PdpGeoRetrievedChunk,
  PdpGeoReviewItem,
  PdpGeoSchemaMarkup,
  PdpGeoSchemaTarget,
  PdpGeoTerminologyDiagnostics,
  PdpProductSignal,
  PdpSemanticMetricClaim
} from "./types";

interface GenerateArtifactsInput {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  sourceUrl?: string;
  hints?: PdpGeoGenerationHints;
  ragChunks: PdpGeoRetrievedChunk[];
  ragDocuments: Array<{
    name: string;
    content: string;
  }>;
  reasoning?: PdpGeoReasoningResult;
  contentPlan?: PdpGeoContentPlan;
}

interface GenerateArtifactsOutput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  recommendations: PdpGeoRecommendation[];
  evidence: PdpGeoEvidence[];
  terminology: PdpGeoTerminologyDiagnostics;
  inferredSearchQueries: PdpGeoInferredSearchQueryDiagnostic[];
}

interface TerminologyConcept {
  concept: string;
  category?: string;
  preferred?: Partial<Record<PdpGeoLocale, string[]>>;
  avoid?: Partial<Record<PdpGeoLocale, string[]>>;
  notes?: string;
}

interface GeoOptimizationGuidance {
  sources: string[];
  principles: string[];
  reasoning: PdpGeoReasoningResult;
  useAnswerReadyFaq: boolean;
  useStepwiseUsage: boolean;
  useEvidenceBackedClaims: boolean;
  useTargetCustomerContext: boolean;
  useReviewIntentFaq: boolean;
}

interface ProductAdditionalPropertyEntry {
  name: string;
  value?: string;
  propertyID?: string;
}

const defaultTargets: PdpGeoSchemaTarget[] = ["WebPage", "Product", "FAQPage", "BreadcrumbList"];

const genericCategoryPattern = /^(usage|use|how to use|direction|directions|review|reviews|rating|ratings|benefit|benefits|effect|effects|ingredient|ingredients|content|section|product|item|type)$/i;

/** Builds deterministic GEO artifacts from normalized product signals and selected RAG chunks. */
export function generatePdpGeoArtifacts(input: GenerateArtifactsInput): GenerateArtifactsOutput {
  const terminologyConcepts = readTerminologyConcepts(input.ragDocuments);
  const reasoning = input.reasoning ?? createPdpGeoReasoning({
    product: input.product,
    locale: input.locale,
    market: input.market,
    ragChunks: input.ragChunks
  });
  const guidance = createGeoOptimizationGuidance(input.ragChunks, reasoning);
  const terminology = createTerminologyDiagnostics(input.locale, input.market);
  const recommendations: PdpGeoRecommendation[] = [];
  const evidence: PdpGeoEvidence[] = [];
  const detectedConcepts = detectTerminologyConcepts(input.product, terminologyConcepts);
  const localizedTerms = detectedConcepts.flatMap((concept) => preferredTerms(concept, input.locale).slice(0, 1));
  const productName = applyAvoidTerms(
    createGeoProductName(input.product, input.locale, localizedTerms, input.hints),
    terminologyConcepts,
    input.locale,
    terminology
  );
  const optimizedUsageSteps = createOptimizedUsageSteps(input.product, input.locale, guidance);
  const modelPlanned = input.contentPlan?.mode === "model";
  const plannedFaq = (input.contentPlan?.faq ?? [])
    .filter((item) => item.include)
    .map((item) => ({ question: item.question, answer: item.answer }));
  // A model content plan is a fail-closed membership contract. FAQ candidates
  // rejected by the planner's evidence gate must not be restored by the
  // deterministic fallback, otherwise contentPlan, FAQPage and visible copy
  // describe different approved sets.
  const faq = modelPlanned
    ? plannedFaq
    : ensureFaq(input.product, input.locale, productName, guidance, optimizedUsageSteps);
  const plannedHowToSteps = input.contentPlan?.howTo.eligible
    ? normalizePlannedHowToSteps(input.contentPlan.howTo.steps.map((step) => ({ name: step.name, text: step.text })), input.locale)
    : [];
  const inferredProductDescription = normalizeInferencePublicText(modelPlanned
    ? plannedDescriptionOrSource(
      input.contentPlan?.productDescription,
      input.product,
      productName,
      input.locale,
      "product",
      () => applyAvoidTerms(createGeoDescription(input.product, productName, input.locale, localizedTerms, guidance, optimizedUsageSteps), terminologyConcepts, input.locale, terminology)
    )
    : applyAvoidTerms(createGeoDescription(input.product, productName, input.locale, localizedTerms, guidance, optimizedUsageSteps), terminologyConcepts, input.locale, terminology), input.locale);
  const inferredWebPageDescription = normalizeInferencePublicText(modelPlanned
    ? plannedDescriptionOrSource(
      input.contentPlan?.webPageDescription,
      input.product,
      productName,
      input.locale,
      "webpage",
      () => applyAvoidTerms(createWebPageDescription(input.product, productName, input.locale, localizedTerms, optimizedUsageSteps), terminologyConcepts, input.locale, terminology)
    )
    : applyAvoidTerms(
      createWebPageDescription(input.product, productName, input.locale, localizedTerms, optimizedUsageSteps),
      terminologyConcepts,
      input.locale,
      terminology
    ), input.locale);
  const productDescription = enforceDescriptionEntityMentionBudget(inferredProductDescription, productName, input.locale, 1);
  const webPageDescription = enforceDescriptionEntityMentionBudget(inferredWebPageDescription, productName, input.locale, 2);
  const inferredSearchQueries = createInferredSearchQueryDiagnostics(input.product, input.locale, input.contentPlan);
  const sections: PdpGeoContentSections = {
    productName,
    description: productDescription,
    quickFacts: normalizeInferencePublicText(applyAvoidTerms(createQuickFacts(input.product, input.locale, localizedTerms, guidance), terminologyConcepts, input.locale, terminology), input.locale),
    benefits: normalizeInferencePublicText(applyAvoidTerms(createBenefitsSection(input.product, input.locale, guidance), terminologyConcepts, input.locale, terminology), input.locale),
    ingredients: normalizeInferencePublicText(applyAvoidTerms(createIngredientsSection(input.product, input.locale), terminologyConcepts, input.locale, terminology), input.locale),
    howToUse: normalizeInferencePublicText(applyAvoidTerms(createHowToUseSection(input.product, input.locale, optimizedUsageSteps), terminologyConcepts, input.locale, terminology), input.locale),
    faq: normalizeInferencePublicText(applyAvoidTerms(createFaqSection(faq, input.locale), terminologyConcepts, input.locale, terminology), input.locale)
  };

  for (const term of localizedTerms) {
    const concept = detectedConcepts.find((item) => preferredTerms(item, input.locale).includes(term));
    terminology.appliedTerms.push({
      concept: concept?.concept ?? "locale-term",
      term,
      field: "description"
    });
  }

  recommendations.push(...createRecommendations(input.product, sections, detectedConcepts, input.locale, guidance));
  evidence.push(
    { field: "content.productName", source: "input", value: input.product.name },
    { field: "content.description", source: "rag", value: `Description follows target customer + product identity + ingredient/technology + benefit/effect or citation-ready metric + high-level usage/comparison/review context. ${input.ragChunks.length} RAG chunks selected.` }
  );
  if (modelPlanned && plannedFaq.length > 0) {
    evidence.push({
      field: "content.faq",
      source: "input",
      value: `Rendered exactly ${plannedFaq.length} FAQ item(s) approved by the evidence-bound model content plan without fallback replenishment.`
    });
  }
  if (inferredSearchQueries.length > 0) {
    evidence.push({
      field: "diagnostics.inferredSearchQueries",
      source: "rag",
      value: inferredSearchQueries
        .map((query) => `${query.kind}: ${query.question} [${query.keywords.join(", ")}]`)
        .join(" / ")
    });
  }
  if (guidance.sources.length > 0) {
    evidence.push({
      field: "rag.geoOptimizationGuidance",
      source: "rag",
      value: `Reconstructed HowTo, FAQ, and benefit content with GEO guidance from: ${guidance.sources.join(", ")}`
    });
  }
  const enabledReasoning = guidance.reasoning.decisions.filter((decision) => decision.enabled);
  if (enabledReasoning.length > 0) {
    evidence.push({
      field: "rag.reasoning",
      source: "rag",
      value: enabledReasoning
        .map((decision) => `${decision.principle}: ${decision.ragSources.join(", ")} + ${decision.productEvidence.length} product evidence item(s)`)
        .join(" / ")
    });
  }
  const officialDocSources = selectedOfficialDocSources(input.ragChunks);
  if (officialDocSources.length > 0) {
    recommendations.push({
      field: "schema",
      message: officialDocSources.join(", "),
      reason: "Official AI/search platform docs were selected to guide retrieval, structured data, grounding, and answer eligibility constraints."
    });
    evidence.push({
      field: "rag.officialPlatformDocs",
      source: "rag",
      value: `Selected official platform docs: ${officialDocSources.join(", ")}`
    });
  }

  const schemaMarkup = createSchemaMarkup({
    product: input.product,
    productName,
    productDescription,
    webPageDescription,
    faq,
    usageInstructions: optimizedUsageSteps,
    howToSteps: plannedHowToSteps,
    howToName: input.contentPlan?.howTo.goal,
    contentPlan: input.contentPlan,
    locale: input.locale,
    market: input.market,
    sourceUrl: input.sourceUrl,
    targets: resolveSchemaTargets(input.hints?.schemaTargets, plannedHowToSteps.length >= 2)
  });
  const content = {
    html: createPdpGeoContentHtml(sections, input.locale),
    sections
  };

  return {
    schemaMarkup,
    content,
    recommendations,
    evidence,
    terminology,
    inferredSearchQueries
  };
}

function plannedDescriptionOrSource(
  field: PdpGeoContentPlan["productDescription"] | undefined,
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  kind: "product" | "webpage",
  createEvidenceBackedFallback: () => string
): string {
  if (field?.include && cleanSignal(field.text)) {
    return cleanSignal(field.text);
  }
  const evidenceBackedFallback = cleanSignal(createEvidenceBackedFallback());
  if (evidenceBackedFallback && isDescriptionLocaleCompatible(evidenceBackedFallback, product, locale)) {
    return evidenceBackedFallback;
  }
  const sourceDescription = cleanSignal(product.description ?? "");
  if (kind === "product" && sourceDescription && isDescriptionLocaleCompatible(sourceDescription, product, locale)) {
    return sourceDescription;
  }
  if (locale === "ko-KR") {
    return kind === "product"
      ? `${productName} 제품입니다.`
      : `${productName}에 대해 제공된 정보를 확인할 수 있는 상품 페이지입니다.`;
  }
  if (locale === "ja-JP") {
    return kind === "product"
      ? `${productName}の商品です。`
      : `${productName}について提供された情報を確認できる商品ページです。`;
  }
  return kind === "product"
    ? `${productName} is a product.`
    : `This product page presents the supplied information about ${productName}.`;
}

function isDescriptionLocaleCompatible(value: string, product: PdpProductSignal, locale: PdpGeoLocale): boolean {
  const identityValues = [product.name, product.originalName, product.brand].filter((item): item is string => Boolean(item));
  const content = identityValues.reduce((text, identity) => {
    const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(escapedIdentity, "giu"), " ");
  }, value);
  const sample = cleanSignal(content) || value;
  const hangul = (sample.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (locale === "ko-KR") return hangul >= 3;
  if (locale === "ja-JP") return kana >= 2;
  return latin >= 3 && hangul === 0 && kana === 0;
}

function resolveSchemaTargets(requested: PdpGeoSchemaTarget[] | undefined, howToEligible: boolean): PdpGeoSchemaTarget[] {
  const base = requested ?? defaultTargets;
  const targets = howToEligible && !requested ? [...base, "HowTo" as const] : base;
  return unique(targets).filter((target): target is PdpGeoSchemaTarget => target !== "HowTo" || howToEligible);
}

function createGeoProductName(product: PdpProductSignal, _locale: PdpGeoLocale, _localizedTerms: string[], _hints?: PdpGeoGenerationHints): string {
  return canonicalProductEntityName(product) ?? product.name.trim();
}

function canonicalProductEntityName(product: PdpProductSignal): string | undefined {
  const sourceName = cleanSignal(product.name);
  if (!sourceName) {
    return undefined;
  }

  const bracketTokens = Array.from(sourceName.matchAll(/\[([^\]]{1,36})\]/g))
    .map((match) => cleanSignal(match[1] ?? ""))
    .filter(Boolean);
  const sourceBackedBrand = selectSourceBackedBrandPrefix(product.brand, bracketTokens);
  const hasSkuQualifier = bracketTokens.some(isVariantOrCommerceToken)
    || product.options.length > 0
    || /\b\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\b/.test(sourceName);

  let name = sourceName
    .replace(/\[[^\]]{1,36}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (hasSkuQualifier) {
    name = name
      .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\s*$/i, "")
      .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz)\b.*$/i, "")
      .trim();
  }

  if (!name) {
    return undefined;
  }
  if (sourceBackedBrand && !containsEntityToken(name, sourceBackedBrand)) {
    name = `${sourceBackedBrand} ${name}`;
  }
  return cleanSignal(name);
}

function selectSourceBackedBrandPrefix(brand: string | undefined, bracketTokens: string[]): string | undefined {
  const cleanBrand = cleanSignal(brand ?? "");
  if (cleanBrand && bracketTokens.some((token) => sameEntityToken(token, cleanBrand))) {
    return cleanBrand;
  }
  return undefined;
}

function isVariantOrCommerceToken(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return false;
  }
  return /\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)|%|\+|[₩$€£¥]|(?:^|[\s-])(?:set|kit|bundle|refill|mini|trial|sample|gift|limited|special|online|exclusive|new|best|sale)(?:$|[\s-])/i.test(text);
}

function containsEntityToken(value: string, token: string): boolean {
  const normalizedValue = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const normalizedToken = token.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return Boolean(normalizedToken) && normalizedValue.includes(normalizedToken);
}

function sameEntityToken(left: string, right: string): boolean {
  return cleanSignal(left).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
    === cleanSignal(right).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function createGeoDescription(
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  guidance: GeoOptimizationGuidance,
  optimizedUsageSteps: string[] = []
): string {
  const context = createDescriptionContext(product, productName, locale, localizedTerms, optimizedUsageSteps);
  const benefit = context.benefitPhrase ?? fallback(locale, {
    "ko-KR": "제품의 핵심 케어",
    "ja-JP": "商品の主要なケア",
    "en-US": "the product's core care benefit",
    "en-GB": "the product's core care benefit"
  });
  const evidence = guidance.useEvidenceBackedClaims ? context.reportedDetail : undefined;

  switch (locale) {
    case "ko-KR":
      const productEvidenceDescriptions = createKoreanDetailedProductEvidenceDescriptions(product, context);
      return connectKoreanBenefitAndEfficacyNarrative(compactSentence([
        createKoreanProductLeadDescription(productName, context, benefit),
        ...productEvidenceDescriptions,
        createCitationReadyProductEvidenceDescription(locale, evidence),
        createKoreanEfficacySuitabilityDescription(context),
        createProductSafetyEvidenceDescription(product, locale),
        createKoreanDetailedProductReviewDescription(context)
      ]));
    case "ja-JP":
      return compactSentence([
        createJapaneseProductLeadDescription(productName, context),
        createProductIngredientDescription(locale, context),
        createCitationReadyProductEvidenceDescription(locale, evidence),
        createLocalizedUsageComparisonDescription(product, locale, context),
        createProductSafetyEvidenceDescription(product, locale),
        createLocalizedReviewDescription(locale, context)
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        createEnglishProductLeadDescription(productName, context),
        createProductIngredientDescription(locale, context),
        createCitationReadyProductEvidenceDescription(locale, evidence),
        createLocalizedUsageComparisonDescription(product, locale, context),
        createProductSafetyEvidenceDescription(product, locale),
        createLocalizedReviewDescription(locale, context)
      ]);
  }
}

function createCitationReadyProductEvidenceDescription(locale: PdpGeoLocale, reportedDetail?: string): string | undefined {
  return isCitationReadyWebPageReportedDetail(reportedDetail) && isDescriptionReadyReportedDetail(reportedDetail)
    ? createProductEvidenceDescription(locale, reportedDetail ?? "")
    : undefined;
}

function createWebPageDescription(
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  optimizedUsageSteps: string[] = []
): string {
  const context = createDescriptionContext(product, productName, locale, localizedTerms, optimizedUsageSteps);

  switch (locale) {
    case "ko-KR":
      return connectKoreanBenefitAndEfficacyNarrative(compactSentence([
        createKoreanWebPageCoverageLead(product, productName, context),
        createKoreanWebPageCoverageScopeDescription(product, productName, context),
        createKoreanWebPageOptionFactForNarrative(product, context),
        createCitationReadyWebPageEvidenceDescription(locale, context.reportedDetail),
        createKoreanEfficacySuitabilityDescription(context),
        createKoreanWebPageDecisionContextDescription(context)
      ]));
    case "ja-JP":
      return compactSentence([
        createJapaneseWebPageCoverageLead(product, productName, context),
        createJapaneseWebPageCoverageScopeDescription(product, context),
        createJapaneseWebPageDecisionDescription(context),
        createJapaneseWebPageAnswerCoverageDescription(product, context),
        context.usage ? createWebPageUsageDescription(locale, context.usage) : undefined,
        createCitationReadyWebPageEvidenceDescription(locale, context.reportedDetail)
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        createEnglishWebPageCoverageLead(product, productName, context),
        createEnglishWebPageProductEvidenceDescription(productName, context),
        !context.ingredientPhrase && context.pageFactPhrase ? createEnglishWebPageFactDescription(context.pageFactPhrase) : undefined,
        context.usage ? createWebPageUsageDescription(locale, context.usage) : undefined,
        context.reviewPhrase ? `It also reflects customer review language such as ${context.reviewPhrase}` : undefined,
        createCitationReadyWebPageEvidenceDescription(locale, context.reportedDetail)
      ]);
  }
}

function connectKoreanBenefitAndEfficacyNarrative(value: string): string {
  return value
    .replace(/\s*돕습니다\.\s+(?=(?:한\s*번\s*사용\s*후|사용\s*직후|단\s*\d+(?:\.\d+)?\s*분\s*만에))/u, " 돕고, ")
    .replace(/\s+/g, " ")
    .trim();
}

function createKoreanEfficacySuitabilityDescription(context: DescriptionContext): string | undefined {
  if (!context.reportedDetail || !hasKoreanGroupedEfficacyNarrative(context.reportedDetail)) {
    return undefined;
  }
  const targetCustomer = simplifyKoreanTargetCustomerForSentence(context.targetCustomer);
  return targetCustomer
    ? `이러한 효능·효과를 바탕으로 ${targetCustomer}에게 적합합니다`
    : undefined;
}

function hasKoreanGroupedEfficacyNarrative(value: string): boolean {
  if (createKoreanCompoundEfficacyNarrative(value)) {
    return true;
  }
  const text = cleanSignal(value);
  const measuredOutcomes = text.match(/\d+(?:\.\d+)?\s*(?:%|％|배)\s*(?:증가|감소|개선|회복|향상|완화|상승)/gu) ?? [];
  const hasStudyContext = /(?:인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|사용성\s*시험)/u.test(text)
    && /(?:\d+\s*명|여성|남성|성인|대상자|참여자)/u.test(text);
  const hasMeasuredTiming = /(?:사용|도포|적용|세정)\s*(?:직후|즉시|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*(?:후|만에))/u.test(text);
  return measuredOutcomes.length >= 2
    && hasStudyContext
    && (isKoreanDurationEfficacyDetail(text) || hasMeasuredTiming);
}

function createCitationReadyWebPageEvidenceDescription(locale: PdpGeoLocale, reportedDetail?: string): string | undefined {
  return isCitationReadyWebPageReportedDetail(reportedDetail) && isDescriptionReadyReportedDetail(reportedDetail)
    ? createWebPageEvidenceDescription(locale, reportedDetail ?? "")
    : undefined;
}

function isDescriptionReadyReportedDetail(value: string | undefined): boolean {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return false;
  }
  return !/(?:해당\s*결과|원료적\s*특성에\s*한한|원문\s*공개\s*범위|시험\s*대상\/표본\s*수|표기되어\s*있|결과(?:가|는)?\s*제시|수치(?:가|는)?\s*제시|public\s+source\s+text|does\s+not\s+disclose|reported\s+details?)/iu.test(text);
}

function isCitationReadyWebPageReportedDetail(value: string | undefined): boolean {
  const text = cleanSignal(value ?? "");
  if (!text || !hasQuantifiedReportedSignal(text)) {
    return false;
  }
  const hasEvaluationContext = /(?:테스트|시험|임상|인체\s*적용|자가\s*평가|소비자\s*평가|설문|대상|시험기간|clinical|study|self[-\s]?assessment|instrumental|participants?|subjects?|users?|women|men)/i.test(text);
  const hasTimedOutcome = /(?:사용|도포|적용|세정)\s*(?:즉시|직후|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후)/i.test(text)
    && /(?:회복|개선|감소|증가|상승|향상|완화|잔존|지속|improv|increase|decrease|recover|retain|last)/i.test(text);
  const hasLabeledOutcome = /(?:회복|개선|감소|증가|상승|향상|완화|잔존|지속|improv|increase|decrease|recover|retain|last)/i.test(text)
    && !/(?:GLOWPICK|fl\.?\s*oz|4\s*fl|120\s*ml|ppm)/i.test(text);
  return hasEvaluationContext || hasTimedOutcome || hasLabeledOutcome;
}

function createKoreanWebPageCoverageLead(product: PdpProductSignal, productName: string, context: DescriptionContext): string {
  const targetCustomer = simplifyKoreanTargetCustomerForSentence(context.targetCustomer);
  const productIntro = createKoreanWebPageProductIntroNoun(product, context);
  if (targetCustomer) {
    return `${productName} 상품 페이지는 ${appendKoreanObjectParticle(targetCustomer)} 위한 ${appendKoreanObjectParticle(productIntro)} 소개합니다`;
  }
  return `${productName} 상품 페이지는 ${appendKoreanObjectParticle(productIntro)} 소개합니다`;
}

function createKoreanWebPagePrimaryFactsPhrase(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  return formatDescriptionList(unique([
    context.benefitPhrase ? `${context.benefitPhrase} 효능` : undefined,
    context.ingredientPhrase ? `${context.ingredientPhrase} 성분/기술` : undefined,
    context.reviewPhrase ? `${context.reviewPhrase} 리뷰 표현` : undefined,
    product.options.length > 0 ? "옵션/용량" : undefined,
    formatKoreanWebPageReportedDetailFact(context.reportedDetail)
  ].filter((value): value is string => Boolean(value))), "ko-KR", 3);
}

function formatKoreanWebPageReportedDetailFact(reportedDetail?: string): string | undefined {
  const detail = trimTrailingSentencePunctuation(cleanSignal(reportedDetail ?? ""))
    .replace(/^측정\/평가\s*(?:정보|결과)?(?:는|:)?\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) {
    return undefined;
  }
  const conciseDetail = detail.length > 72 ? truncateAtCompleteSentence(detail, 72) : detail;
  return `${conciseDetail} 측정/평가 결과`;
}

function formatKoreanWebPageTargetCustomerSubject(value: string): string {
  const target = simplifyKoreanTargetCustomerForSentence(value);
  const normalized = target || "고객";
  return appendKoreanSubjectParticle(normalized);
}

function simplifyKoreanTargetCustomerForSentence(value: string): string {
  const target = trimTrailingSentencePunctuation(cleanSignal(value))
    .replace(/\s*(?:에게|에)\s*(?:적합|추천)(?:합니다|됩니다|되는|된)?$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!target) {
    return "";
  }
  if (/^고객$/u.test(target)) {
    return "";
  }
  if (/(?:건조|건성|피부\s*장벽|장벽|보습|수분)/u.test(target) && /민감/u.test(target)) {
    return "건조하고 민감한 피부 고객";
  }
  if (/건조/u.test(target) && /모든\s*피부/u.test(target)) {
    return "건조 피부 고객";
  }
  return target;
}

function createKoreanWebPageBenefitContext(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const evidenceText = allProductEvidenceText(product);
  const concepts: string[] = [];
  if (/(?:피부\s*장벽|피부장벽|장벽)/u.test(evidenceText)) {
    concepts.push("피부 장벽 케어");
  }
  if (/(?:속\s*보습|속보습)/u.test(evidenceText)) {
    concepts.push("속보습");
  }
  if (concepts.length < 2 && /(?:수분감|수분\s*공급|수분)/u.test(evidenceText)) {
    concepts.push("수분 케어");
  }
  if (concepts.length < 2 && /(?:보습|수분|hydration|moisture)/i.test(evidenceText)) {
    concepts.push("보습");
  }
  if (concepts.length < 2 && /피부결/u.test(evidenceText)) {
    concepts.push("피부결 정돈");
  }

  const fallbackConcepts = context.benefits
    .map((benefit) => cleanSignal(benefit)
      .replace(/\s*효능$/u, "")
      .replace(/^피부\s*장벽$/u, "피부 장벽 케어")
      .replace(/^수분감$/u, "수분 케어")
      .trim())
    .filter(Boolean);
  return formatKoreanNaturalList(dedupeKoreanBenefitConcepts([...concepts, ...fallbackConcepts]).slice(0, 2));
}

function dedupeKoreanBenefitConcepts(values: string[]): string[] {
  const selected: string[] = [];
  const families = new Set<string>();
  for (const value of unique(values.map(cleanSignal).filter(Boolean))) {
    const family = /(?:수분|보습|촉촉)/u.test(value)
      ? "hydration"
      : /(?:피부\s*장벽|장벽)/u.test(value)
        ? "barrier"
        : /(?:탄력|리프팅)/u.test(value)
          ? "firmness"
          : /(?:피부결|매끄)/u.test(value)
            ? "texture"
            : signalEntityKey(value);
    if (families.has(family)) {
      continue;
    }
    families.add(family);
    selected.push(value);
  }
  return selected;
}

function createKoreanWebPageProductIntroNoun(product: PdpProductSignal, context: DescriptionContext): string {
  const productType = trimTrailingSentencePunctuation(cleanSignal(context.productType || "제품"));
  const evidenceText = allProductEvidenceText(product);
  const moisturePrefix = /(?:토너|스킨|toner)/i.test(productType) && /(?:수분|보습|속\s*보습|속보습|hydration|moisture)/i.test(evidenceText)
    ? "수분 "
    : "";
  return cleanSignal(`${moisturePrefix}${productType} 상품`)
    .replace(/\s*상품\s*상품$/u, " 상품")
    .trim();
}

function shouldRecommendKoreanWebPageProduct(
  product: PdpProductSignal,
  context: DescriptionContext,
  benefitContext?: string
): boolean {
  const evidenceText = allProductEvidenceText(product);
  const hasTargetCustomer = Boolean(context.targetCustomer && !/^고객$/u.test(cleanSignal(context.targetCustomer)));
  const hasBenefit = Boolean(benefitContext) || context.benefits.length > 0;
  const hasRecommendationEvidence = /(?:추천|적합|맞춘|위한|특화|피부\s*타입|skin\s*type|recommended|suitable|designed\s+for|formulated\s+for|speciali[sz]ed\s+for|for\s+(?:dry|sensitive|oily|combination)\s+skin)/i.test(evidenceText);
  return hasTargetCustomer && hasBenefit && hasRecommendationEvidence;
}

function formatKoreanNaturalList(values: string[]): string | undefined {
  const items = unique(values.map(cleanSignal).filter(Boolean));
  if (items.length === 0) {
    return undefined;
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    const head = items[0] ?? "";
    const tail = items[1] ?? "";
    return `${head}${hasKoreanBatchim(head) ? "과" : "와"} ${tail}`;
  }
  return items.join(", ");
}

function createKoreanWebPageCoverageScopeDescription(product: PdpProductSignal, productName: string, context: DescriptionContext): string | undefined {
  const ingredientPhrase = selectKoreanWebPageIngredientTechnologyPhrase(product, context);
  if (ingredientPhrase) {
    return createKoreanWebPageIngredientTechnologyProductSentence(product, productName, context, ingredientPhrase);
  }

  const details = unique([
    context.benefitPhrase ? `${context.benefitPhrase} 효능` : undefined,
    context.reviewPhrase ? `${context.reviewPhrase} 리뷰 표현` : undefined,
    product.options.length > 0 ? "옵션/용량" : undefined,
    context.reportedDetail ? "측정/평가 결과" : undefined
  ].filter((value): value is string => Boolean(value)));
  const coverage = formatDescriptionList(details, "ko-KR", 4);
  return coverage ? `주요 선택 기준은 ${coverage}입니다` : undefined;
}

function createKoreanWebPageIngredientTechnologyProductSentence(
  product: PdpProductSignal,
  productName: string,
  context: DescriptionContext,
  ingredientPhrase: string
): string {
  const productReference = createKoreanShortProductReference(productName, product.brand);
  const benefitContext = createKoreanWebPageBenefitContext(product, context);
  const hasCompoundEfficacy = Boolean(context.reportedDetail && hasKoreanGroupedEfficacyNarrative(context.reportedDetail));
  const targetCustomer = !hasCompoundEfficacy && shouldRecommendKoreanWebPageProduct(product, context, benefitContext)
    ? context.targetCustomer
    : undefined;

  return createKoreanIngredientBenefitTargetSentence(
    ingredientPhrase,
    benefitContext,
    targetCustomer,
    productReference,
    hasCompoundEfficacy ? false : context.ingredientBenefitRelationSupported,
    hasCompoundEfficacy
  );
}

/**
 * Keeps the supported ingredient/formula, product benefit, and target concern in
 * one causal reading unit. `productReference` is intentionally optional: the
 * Product description already names the entity in its lead, while the WebPage
 * description needs the entity here to distinguish the page from its product.
 */
function createKoreanIngredientBenefitTargetSentence(
  ingredientPhrase: string,
  benefitContext?: string,
  targetCustomer?: string,
  productReference?: string,
  relationSupported = false,
  connectProductFacts = false
): string {
  if (!benefitContext) {
    return productReference
      ? createKoreanIngredientTechnologyCompositionSentence(productReference, ingredientPhrase)
      : createKoreanIngredientTechnologyContinuationSentence(ingredientPhrase);
  }

  if (!relationSupported) {
    const composition = productReference
      ? createKoreanIngredientTechnologyCompositionSentence(productReference, ingredientPhrase)
      : createKoreanIngredientTechnologyContinuationSentence(ingredientPhrase);
    if (!connectProductFacts) {
      return `${trimTrailingSentencePunctuation(composition)}. 주요 효능은 ${benefitContext}입니다`;
    }
    const compositionConnector = trimTrailingSentencePunctuation(composition)
      .replace(/로\s*구성됩니다$/u, "로 구성되며")
      .replace(/적용되어\s*있습니다$/u, "적용되어 있으며")
      .replace(/입니다$/u, "이며");
    return `${compositionConnector}, ${appendKoreanObjectParticle(benefitContext)} 돕습니다`;
  }

  const composition = createKoreanIngredientTechnologyCompositionClause(ingredientPhrase, productReference);
  const concernCustomer = formatKoreanTargetConcernCustomer(targetCustomer);
  const benefit = appendKoreanObjectParticle(benefitContext);
  const outcome = concernCustomer
    ? `${benefit} 도와 ${concernCustomer}에게 적합합니다`
    : `${benefit} 돕습니다`;
  return `${composition}, ${outcome}`;
}

function createKoreanIngredientTechnologyCompositionClause(ingredientPhrase: string, productReference?: string): string {
  const normalizedIngredient = stripKoreanPatentQualifier(ingredientPhrase);
  const role = inferIngredientTechnologyRole(ingredientPhrase);

  if (role === "ingredient") {
    return productReference
      ? `${appendKoreanTopicParticle(productReference)} 주요 성분인 ${appendKoreanInstrumentParticle(normalizedIngredient)} 구성되어 있으며`
      : `주요 성분은 ${normalizedIngredient}이며`;
  }
  if (role === "formula") {
    return productReference
      ? `${productReference}에는 ${appendKoreanSubjectParticle(normalizedIngredient)} 주요 기술로 적용되어 있으며`
      : `${appendKoreanSubjectParticle(normalizedIngredient)} 주요 기술로 적용되어 있으며`;
  }
  return productReference
    ? `${appendKoreanTopicParticle(productReference)} 주요 성분과 기술인 ${appendKoreanObjectParticle(normalizedIngredient)} 바탕으로 구성되어 있으며`
    : `주요 성분과 기술은 ${normalizedIngredient}이며`;
}

function createKoreanIngredientTechnologyContinuationSentence(ingredientPhrase: string): string {
  const normalizedIngredient = stripKoreanPatentQualifier(ingredientPhrase);
  const role = inferIngredientTechnologyRole(ingredientPhrase);
  if (role === "ingredient") {
    return `주요 성분은 ${normalizedIngredient}입니다`;
  }
  if (role === "formula") {
    return `${appendKoreanSubjectParticle(normalizedIngredient)} 주요 기술로 적용되어 있습니다`;
  }
  return `주요 성분과 기술은 ${normalizedIngredient}입니다`;
}

function formatKoreanTargetConcernCustomer(value: string | undefined): string | undefined {
  const target = simplifyKoreanTargetCustomerForSentence(value ?? "");
  if (!target || /^고객$/u.test(target)) {
    return undefined;
  }
  if (/고민/u.test(target)) {
    return target;
  }
  const withoutCustomer = target.replace(/\s*고객$/u, "").trim();
  return /피부$/u.test(withoutCustomer)
    ? `${appendKoreanSubjectParticle(withoutCustomer)} 고민인 고객`
    : target;
}

function createKoreanIngredientTechnologyCompositionSentence(productReference: string, ingredientPhrase: string): string {
  const normalizedIngredient = stripKoreanPatentQualifier(ingredientPhrase);
  const productSubject = appendKoreanTopicParticle(productReference);
  const role = inferIngredientTechnologyRole(ingredientPhrase);
  if (role === "ingredient") {
    return `${productReference}의 주요 성분은 ${appendKoreanInstrumentParticle(normalizedIngredient)} 구성됩니다`;
  }
  if (role === "formula") {
    return `${productReference}에는 주요 기술로 ${appendKoreanSubjectParticle(normalizedIngredient)} 적용되어 있습니다`;
  }
  return `${productSubject} 주요 성분과 기술인 ${appendKoreanObjectParticle(normalizedIngredient)} 바탕으로 구성됩니다`;
}

type IngredientTechnologyRole = "ingredient" | "formula" | "mixed";

function inferIngredientTechnologyRole(value: string): IngredientTechnologyRole {
  const text = cleanSignal(value);
  const hasFormulaOrProcess = /(?:기술|테크놀로지|공법|포뮬러|서스펜션|Formula|formula|technolog(?:y|ies)|tech|method|process|system|処方|技術|フォーミュラ|製法|フローティング)/iu.test(text);
  const hasIngredientOrCapsule = /(?:성분|원료|캡슐|워터|세라마이드|콜레스테롤|지방산|히알루론산|레티놀|나이아신아마이드|펩타이드|PHA|ingredient|capsule|water|ceramide|cholesterol|fatty\s+acid|hyaluronic|retinol|niacinamide|peptide|成分|原料|カプセル|ウォーター|水|セラミド|コレステロール|脂肪酸|ヒアルロン酸|レチノール|ナイアシンアミド|ペプチド)/iu.test(text);

  if (hasFormulaOrProcess && hasIngredientOrCapsule) {
    return "mixed";
  }
  if (hasFormulaOrProcess) {
    return "formula";
  }
  return "ingredient";
}

function inferKoreanIngredientTechnologyBridge(value: string): { withBenefit: string; withoutBenefit: string } {
  const role = inferIngredientTechnologyRole(value);

  if (role === "formula") {
    return { withBenefit: "적용해", withoutBenefit: "적용한" };
  }
  if (role === "mixed") {
    return { withBenefit: "바탕으로", withoutBenefit: "바탕으로 구성한" };
  }
  return { withBenefit: "담아", withoutBenefit: "담은" };
}

function selectKoreanPrimaryProductIngredient(product: PdpProductSignal): string | undefined {
  const evidenceText = roleCoherentIngredientEvidenceTexts(product).join(" ");
  const isPrimaryIngredient = (value: string): boolean => /(?:세라마이드|펩타이드|레티놀|히알루론산|피토스핑고신|콜레스테롤|진세노믹스|비타민|ceramide|peptide|retinol|hyaluronic)/i.test(value)
    && !/(?:공법|포뮬러|technology|formula)/i.test(value);
  const structuredPrimary = product.ingredients
    .filter((value) => cleanSignal(value).length <= 64 && !/[.。！？?]/u.test(value))
    .flatMap((value) => splitIngredientSignal(value))
    .map((value) => normalizeKoreanWebPageIngredientTechnologySignal(value, evidenceText))
    .find((value): value is string => typeof value === "string" && isPrimaryIngredient(value) && isUsefulKeyIngredientSignal(value, product));
  const concretePrimary = product.ingredients
    .flatMap((value) => extractConcreteIngredientTechnologySignals(value))
    .map((value) => normalizeKoreanWebPageIngredientTechnologySignal(value, evidenceText))
    .find((value): value is string => typeof value === "string" && isPrimaryIngredient(value) && isUsefulKeyIngredientSignal(value, product));
  const explicitlyNamedPrimary = extractKoreanExplicitPrimaryIngredient(evidenceText);
  return explicitlyNamedPrimary ?? structuredPrimary ?? concretePrimary ?? selectKoreanWebPageIngredientTechnologySignals(product).find(isPrimaryIngredient);
}

function extractKoreanExplicitPrimaryIngredient(value: string): string | undefined {
  const text = cleanSignal(value);
  const match = text.match(/(?:핵심|주요)\s*성분(?:은|으로|:)?\s*([가-힣A-Za-z0-9®™+\-/ ]{2,64}?)(?=\s*(?:로\s*(?:표시|소개|설명)|입니다|이며|이고|추천|[,.。]|$))/u)?.[1];
  const candidate = cleanSignal(match ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return candidate && !isIngredientAttributeOrOutcomeSignal(candidate) ? candidate : undefined;
}

function selectKoreanWebPageIngredientTechnologyPhrase(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const signals = selectKoreanWebPageIngredientTechnologySignals(product, context);
  const rankedDirectIngredients = selectKoreanDetailedProductMainIngredients(
    product,
    selectDirectKoreanProductIngredientSignals(product, 16),
    4
  );
  const descriptionPrimary = unique([...context.ingredients, ...rankedDirectIngredients, ...signals])
    .map((candidate) => ({ candidate, index: productEvidenceFactIndex(product.description ?? "", candidate) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.candidate.length - left.candidate.length)[0]?.candidate;
  const structuredPrimary = selectKoreanPrimaryProductIngredient(product);
  const primary = descriptionPrimary && structuredPrimary
    && descriptionFactMatches(descriptionPrimary, structuredPrimary)
    && structuredPrimary.length > descriptionPrimary.length
    ? structuredPrimary
    : descriptionPrimary ?? structuredPrimary ?? first(rankedDirectIngredients) ?? first(signals);
  const secondaryCandidates = unique([...rankedDirectIngredients, ...signals])
    .filter((value) => value !== primary && !shareIngredientFamily(value, primary));
  // A "main ingredients" sentence should prefer another concrete ingredient
  // over a named delivery/formula technology. Technology remains eligible when
  // the source does not provide a second ingredient.
  const secondary = secondaryCandidates.find((value) => inferIngredientTechnologyRole(value) === "ingredient")
    ?? first(secondaryCandidates);
  return formatKoreanNaturalList([primary, secondary].filter((value): value is string => Boolean(value)));
}

function shareIngredientFamily(left: string, right?: string): boolean {
  if (!right) {
    return false;
  }
  const family = (value: string): string => {
    const text = cleanSignal(value).toLocaleLowerCase();
    const families: Array<[string, RegExp]> = [
      ["ceramide", /세라마이드|ceramide/iu],
      ["hyaluronic", /히알루론산|하이알루론산|hyaluronic/iu],
      ["retinol", /레티놀|retinol/iu],
      ["niacinamide", /나이아신아마이드|niacinamide/iu],
      ["peptide", /펩타이드|peptide/iu],
      ["ginseng", /인삼|진생|ginseng|ginsenomics/iu],
      ["cholesterol", /콜레스테롤|cholesterol/iu]
    ];
    return families.find(([, pattern]) => pattern.test(text))?.[0] ?? signalEntityKey(text);
  };
  return family(left) === family(right);
}

function selectKoreanWebPageIngredientTechnologySignals(product: PdpProductSignal, context?: DescriptionContext): string[] {
  const evidenceText = roleCoherentIngredientEvidenceTexts(product).join(" ");
  const directProductSignals = selectDirectKoreanProductIngredientSignals(product, 16);
  const primaryStructuredIngredient = product.ingredients
    .flatMap((value) => splitIngredientSignal(value))
    .map((value) => normalizeKoreanWebPageIngredientTechnologySignal(value, evidenceText))
    .find((value): value is string => typeof value === "string" && isUsefulKeyIngredientSignal(value, product));
  const preferred = [
    primaryStructuredIngredient,
    extractKoreanCeramideConcentration(evidenceText),
    extractKoreanFormulaTechnologyPhrase(evidenceText)
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    ...preferred,
    ...(context?.ingredients ?? []),
    ...product.ingredients,
    ...roleCoherentIngredientEvidenceTexts(product)
  ]
    .flatMap((value) => splitIngredientSignal(value))
    .map((value) => normalizeKoreanWebPageIngredientTechnologySignal(value, evidenceText))
    .filter((value): value is string => Boolean(value));
  return dedupePublicListValues([...preferred, ...candidates])
    .filter((value) => directProductSignals.some((direct) => descriptionFactMatches(direct, value))
      || inferIngredientTechnologyRole(value) !== "ingredient")
    .filter((value) => !isLowQualityPublicEvidenceText(value))
    .filter((value) => isUsefulKeyIngredientSignal(value, product))
    .slice(0, 12);
}

function extractKoreanCeramideConcentration(value: string): string | undefined {
  const match = value.match(/(?:세라마이드|Ceramide)\s*10\s*,?\s*000\s*ppm/i);
  return match?.[0] ? cleanSignal(match[0]).replace(/10\s*,?\s*000/u, "10,000") : undefined;
}

function extractKoreanFormulaTechnologyPhrase(value: string): string | undefined {
  const text = cleanSignal(value);
  const floatingFormula = text.match(/((?:특허\s*출원(?:\s*기술)?\s*)?[\p{L}0-9®™+\-/]{2,28}\s*플로팅\s*포뮬러)/iu)?.[1];
  if (floatingFormula) {
    return stripKoreanPatentQualifier(floatingFormula);
  }
  return first([
    /흔들\s*필요\s*없는\s*특수\s*에멀징\s*공법/u.test(text) ? "흔들 필요 없는 특수 에멀징 공법" : undefined,
    /특수\s*에멀징\s*공법/u.test(text) ? "특수 에멀징 공법" : undefined,
    /하이드로겔\s*서스펜션/u.test(text) ? "하이드로겔 서스펜션" : undefined
  ]);
}

function normalizeKoreanWebPageIngredientTechnologySignal(value: string, evidenceText: string): string | undefined {
  const text = stripKoreanPatentQualifier(cleanSignal(value))
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length < 2 || text.length > 64 || isQuestionLikeText(text) || /[.。！？?]/.test(text)) {
    return undefined;
  }
  const ceramideConcentration = extractKoreanCeramideConcentration(text);
  if (ceramideConcentration) {
    return ceramideConcentration;
  }
  if (/피토스핑고신/u.test(text)) {
    return "피토스핑고신";
  }
  if (/콜레스테롤/u.test(text)) {
    return "콜레스테롤";
  }
  const formulaTechnology = extractKoreanFormulaTechnologyPhrase(text);
  if (formulaTechnology) {
    return formulaTechnology;
  }
  if (/^ceramide$/i.test(text) && /세라마이드/u.test(evidenceText)) {
    return undefined;
  }
  if (/흔들\s*필요\s*없$/u.test(text)) {
    return undefined;
  }
  return normalizeIngredientSignal(text);
}

function stripKoreanPatentQualifier(value: string): string {
  return stripPatentApplicationQualifier(value);
}

function stripPatentApplicationQualifier(value: string): string {
  return cleanSignal(value)
    .replace(/^(?:특허\s*출원(?:된|한)?|특허\s*출원\s*기술|특허\s*기술)\s*/u, "")
    .replace(/^(?:patent[-\s]?pending|patent\s+application(?:\s+technology)?|patent[-\s]?applied)\s+/iu, "")
    .replace(/^(?:特許\s*出願(?:中|済み)?(?:の)?|特許\s*技術(?:の)?|特許(?:取得済み)?(?:の)?)\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createKoreanShortProductReference(productName: string, brand?: string): string {
  const normalizedName = cleanSignal(productName);
  const normalizedBrand = cleanSignal(brand ?? "");
  const normalized = normalizedBrand && normalizedName.toLocaleLowerCase().startsWith(`${normalizedBrand.toLocaleLowerCase()} `)
    ? normalizedName.slice(normalizedBrand.length).trim()
    : normalizedName;
  return normalized || productName;
}

function createKoreanWebPageReviewFactDescription(context: DescriptionContext): string | undefined {
  const reviewPhrase = trimTrailingSentencePunctuation(cleanSignal(context.reviewPhrase ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return reviewPhrase ? `리뷰 표현은 ${reviewPhrase}입니다` : undefined;
}

function createKoreanWebPageDecisionContextDescription(context: DescriptionContext): string | undefined {
  const reviewSummary = createKoreanReviewSummaryDescription(context);
  if (reviewSummary) {
    return reviewSummary;
  }
  return createKoreanWebPageReviewFactDescription(context);
}

function createKoreanWebPageReviewUseFeelContext(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const reviewTerms = unique([
    ...context.reviewKeywords,
    ...selectPublicReviewKeywords(product, "ko-KR")
  ].filter((value) => !isNegativeReviewSignalText(value))).slice(0, 3);
  if (reviewTerms.length === 0) {
    return undefined;
  }
  const reviewPhrase = reviewTerms.join("·");
  const reviewCount = product.reviews.reviewCount;
  return typeof reviewCount === "number" && reviewCount > 0
    ? `${reviewCount}개 리뷰의 ${reviewPhrase} 표현`
    : `고객 리뷰의 ${reviewPhrase} 표현`;
}

function createKoreanWebPageOptionFactDescription(product: PdpProductSignal): string | undefined {
  if (product.options.length === 0) {
    return undefined;
  }
  const options = formatDescriptionList(product.options
    .map(formatKoreanWebPageOptionLabel)
    .filter(isUsefulPublicListValue), "ko-KR", 3);
  return options ? `옵션/용량은 ${options}로 구분됩니다` : "옵션/용량 구성도 제품 선택 기준입니다";
}

function createKoreanWebPageOptionFactForNarrative(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  return context.reportedDetail && hasKoreanGroupedEfficacyNarrative(context.reportedDetail)
    ? undefined
    : createKoreanWebPageOptionFactDescription(product);
}

function formatKoreanWebPageOptionLabel(value: string): string {
  return cleanSignal(value)
    .replace(/\[([^\]]{1,36})\]/g, "$1 ")
    .replace(/(\d+(?:ml|mL|g|매|개|입))\s+[₩￦]?\d[\d,\s]*(?:원)?/g, "$1")
    .replace(/\s+[₩￦]?\d{1,3}(?:,\s?\d{3})+(?:원)?(?:\s*~)?/g, "")
    .replace(/\s+[₩￦]?\d{4,}(?:원)?(?:\s*~)?/g, "")
    .replace(/^[₩￦]?\d[\d,\s]*(?:원)?$/g, "")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function createKoreanWebPageDecisionDescription(context: DescriptionContext): string | undefined {
  const details = unique([
    context.benefitPhrase ? `${context.benefitPhrase} 효능` : undefined,
    context.ingredientPhrase ? `${context.ingredientPhrase} 성분/기술` : undefined,
    context.reviewPhrase ? `${context.reviewPhrase} 리뷰 표현` : undefined
  ].filter((value): value is string => Boolean(value)));
  const phrase = formatDescriptionList(details, "ko-KR", 4);
  return phrase ? `주요 선택 기준은 ${phrase}입니다` : undefined;
}

function createKoreanWebPageAnswerCoverageDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const intents = selectWebPageAnswerIntents(product, context, "ko-KR");
  const phrase = formatDescriptionList(intents, "ko-KR", 6);
  const section = selectKoreanAnswerCoverageSection(product, context);
  return phrase ? `${section}은 ${phrase}에 관한 궁금증을 짧은 답변으로 다룹니다` : undefined;
}

function createJapaneseWebPageCoverageLead(product: PdpProductSignal, productName: string, context: DescriptionContext): string {
  const primaryFacts = formatDescriptionList(selectWebPagePrimaryProductFacts(product, context, "ja-JP"), "ja-JP", 3);
  const target = isSpecificTargetCustomer(context.targetCustomer, "ja-JP") ? `${context.targetCustomer}向けの` : "";
  return primaryFacts
    ? `${productName}の商品ページでは、${target}${context.productType}として${primaryFacts}を中心に紹介します`
    : `${productName}の商品ページでは、${target}${context.productType}として必要な商品情報を紹介します`;
}

function createJapaneseWebPageCoverageScopeDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const coverage = formatDescriptionList(selectWebPageCoverageTopics(product, context, "ja-JP"), "ja-JP", 8);
  return coverage ? `比較材料として${coverage}も補足します` : undefined;
}

function createJapaneseWebPageDecisionDescription(context: DescriptionContext): string | undefined {
  const details = unique([
    context.benefitPhrase ? `${context.benefitPhrase}のベネフィット` : undefined,
    context.ingredientPhrase ? `${stripPatentApplicationQualifier(context.ingredientPhrase)}の処方ポイント` : undefined,
    context.reviewPhrase ? `${context.reviewPhrase}のレビュー表現` : undefined
  ].filter((value): value is string => Boolean(value)));
  const phrase = formatDescriptionList(details, "ja-JP", 4);
  return phrase ? `主な選択基準は${phrase}です` : undefined;
}

function createJapaneseWebPageAnswerCoverageDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const intents = selectWebPageAnswerIntents(product, context, "ja-JP");
  const phrase = formatDescriptionList(intents, "ja-JP", 6);
  const section = selectJapaneseAnswerCoverageSection(product, context);
  return phrase ? `${section}は、${phrase}に関する疑問に短く答えます` : undefined;
}

function createEnglishWebPageCoverageLead(_product: PdpProductSignal, productName: string, context: DescriptionContext): string {
  const target = isSpecificTargetCustomer(context.targetCustomer, "en-US") ? ` for ${context.targetCustomer}` : "";
  return `This ${productName} product page introduces the ${lowercaseEnglishProductType(context.productType)}${target}`;
}

function createEnglishWebPageCoverageScopeDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const coverage = formatDescriptionList(selectWebPageCoverageTopics(product, context, "en-US"), "en-US", 8);
  return coverage ? `For comparison, the page also extends into ${coverage}` : undefined;
}

function createEnglishWebPageProductEvidenceDescription(productName: string, context: DescriptionContext): string | undefined {
  const productSubject = productName;
  if (context.ingredientPhrase && context.benefitPhrase) {
    return createEnglishIngredientTechnologyProductSentence(
      productSubject,
      context.ingredientPhrase,
      context.benefitPhrase,
      context.ingredientDetail,
      context.ingredientBenefitRelationSupported
    );
  }
  if (context.benefitPhrase) {
    return isSpecificTargetCustomer(context.targetCustomer, "en-US")
      ? `${productSubject} emphasizes ${context.benefitPhrase} for ${context.targetCustomer}`
      : `${productSubject} documents ${context.benefitPhrase} as a product benefit`;
  }
  if (context.ingredientPhrase) {
    return createEnglishIngredientTechnologyProductSentence(productSubject, context.ingredientPhrase, undefined, context.ingredientDetail, false);
  }
  return undefined;
}

function createEnglishWebPageAnswerCoverageDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const intentPhrase = formatDescriptionList(selectEnglishAnswerCoverageIntentObjects(product, context), "en-US", 6);
  if (!intentPhrase) {
    return undefined;
  }
  const subjects = selectEnglishAnswerCoverageSubjects(product, context);
  const subjectPhrase = formatDescriptionList(subjects, "en-US", 4) ?? "page-level decision context";
  const verb = subjects.length === 1 && !isEnglishPluralSubject(subjectPhrase) ? "addresses" : "address";
  return `${subjectPhrase} ${verb} ${intentPhrase}`;
}

function createEnglishWebPageFactDescription(fact: string): string {
  const cleanFact = normalizePublicFactText(truncateAtCompleteSentence(fact, 260));
  return `It also includes page-level product facts such as ${formatEnglishFactComplement(cleanFact)}`;
}

function selectKoreanAnswerCoverageSection(product: PdpProductSignal, context: DescriptionContext): string {
  const hasFaq = product.faq.length > 0;
  const hasHowTo = Boolean(context.usage);
  if (hasFaq && hasHowTo) {
    return "FAQ와 사용법 영역";
  }
  if (hasFaq) {
    return "FAQ 영역";
  }
  if (hasHowTo) {
    return "페이지 본문과 사용법 영역";
  }
  return "페이지 본문";
}

function selectJapaneseAnswerCoverageSection(product: PdpProductSignal, context: DescriptionContext): string {
  const hasFaq = product.faq.length > 0;
  const hasHowTo = Boolean(context.usage);
  if (hasFaq && hasHowTo) {
    return "FAQと使い方エリア";
  }
  if (hasFaq) {
    return "FAQエリア";
  }
  if (hasHowTo) {
    return "ページ本文と使い方エリア";
  }
  return "ページ本文";
}

function selectEnglishAnswerCoverageSubjects(product: PdpProductSignal, context: DescriptionContext): string[] {
  return unique([
    product.faq.length > 0 ? "FAQ entries" : undefined,
    context.usage ? "HowTo steps" : undefined,
    product.options.length > 0 ? "variant details" : undefined,
    context.reportedDetail ? "reported-result details" : undefined,
    product.faq.length === 0 && !context.usage && product.options.length === 0 && !context.reportedDetail ? "page-level decision context" : undefined
  ].filter((value): value is string => Boolean(value)));
}

function selectEnglishAnswerCoverageIntentObjects(product: PdpProductSignal, context: DescriptionContext): string[] {
  return unique([
    context.benefitPhrase ? "benefit comparisons" : undefined,
    context.ingredientPhrase ? "formula-context questions" : undefined,
    context.usage ? "routine-use decisions" : undefined,
    context.reviewPhrase ? "comfort, finish, and review interpretation" : undefined,
    product.options.length > 0 ? "variant selection" : undefined,
    context.reportedDetail ? "reported-result interpretation" : undefined
  ].filter((value): value is string => Boolean(value)));
}

function isEnglishPluralSubject(value: string): boolean {
  return /\b(?:entries|steps|details|results|questions)\b/i.test(value) || /\band\b/i.test(value);
}

function selectWebPageCoverageTopics(product: PdpProductSignal, context: DescriptionContext, locale: PdpGeoLocale): string[] {
  if (locale === "ko-KR") {
    return unique([
      context.benefitPhrase ? "효능" : undefined,
      context.ingredientPhrase ? "성분/기술" : undefined,
      context.reviewPhrase ? "리뷰 표현" : undefined,
      product.options.length > 0 ? "옵션/용량" : undefined,
      product.price ? "가격/구매 정보" : undefined,
      context.reportedDetail ? "측정/평가 수치" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  if (locale === "ja-JP") {
    return unique([
      context.benefitPhrase ? "ベネフィット" : undefined,
      context.ingredientPhrase ? "処方ポイント" : undefined,
      context.usage ? "使い方" : undefined,
      context.reviewPhrase ? "レビュー表現" : undefined,
      product.faq.length > 0 ? "FAQ" : undefined,
      context.usage ? "HowTo" : undefined,
      product.options.length > 0 ? "バリエーション/容量" : undefined,
      product.price ? "価格/購入情報" : undefined,
      context.reportedDetail ? "測定/評価数値" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  return unique([
    context.benefitPhrase ? "benefit details" : undefined,
    context.ingredientPhrase ? "formula context" : undefined,
    context.usage ? "usage guidance" : undefined,
    context.reviewPhrase ? "customer review language" : undefined,
    product.faq.length > 0 ? "FAQ answers" : undefined,
    context.usage ? "HowTo steps" : undefined,
    product.options.length > 0 ? "variant or size details" : undefined,
    product.price ? "offer details" : undefined,
    context.reportedDetail ? "reported results" : undefined
  ].filter((value): value is string => Boolean(value)));
}

function selectWebPagePrimaryProductFacts(product: PdpProductSignal, context: DescriptionContext, locale: PdpGeoLocale): string[] {
  if (locale === "ko-KR") {
    return unique([
      context.benefitPhrase ? `${context.benefitPhrase} 효능` : undefined,
      context.ingredientPhrase ? `${context.ingredientPhrase} 성분/기술` : undefined,
      context.usage ? "사용 루틴" : undefined,
      context.reviewPhrase ? `${context.reviewPhrase} 리뷰 표현` : undefined,
      product.options.length > 0 ? "옵션/용량" : undefined,
      context.reportedDetail ? "측정/평가 결과" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  if (locale === "ja-JP") {
    return unique([
      context.benefitPhrase ? `${context.benefitPhrase}のベネフィット` : undefined,
      context.ingredientPhrase ? `${stripPatentApplicationQualifier(context.ingredientPhrase)}の処方ポイント` : undefined,
      context.usage ? "使用ルーティン" : undefined,
      context.reviewPhrase ? `${context.reviewPhrase}のレビュー表現` : undefined,
      product.options.length > 0 ? "バリエーション/容量" : undefined,
      context.reportedDetail ? "測定/評価結果" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  return unique([
    context.benefitPhrase ? `${context.benefitPhrase} benefits` : undefined,
    context.ingredientPhrase ? `${stripPatentApplicationQualifier(context.ingredientPhrase)} in the formula` : undefined,
    context.usage ? "routine use" : undefined,
    context.reviewPhrase ? `${context.reviewPhrase} review language` : undefined,
    product.options.length > 0 ? "variant or size details" : undefined,
    context.reportedDetail ? "reported results" : undefined
  ].filter((value): value is string => Boolean(value)));
}

function selectWebPageAnswerIntents(product: PdpProductSignal, context: DescriptionContext, locale: PdpGeoLocale): string[] {
  if (locale === "ko-KR") {
    return unique([
      context.benefitPhrase ? "효능 비교" : undefined,
      context.ingredientPhrase ? "성분/기술 이해" : undefined,
      context.usage ? "사용 순서" : undefined,
      context.reviewPhrase ? "사용감 판단" : undefined,
      product.options.length > 0 ? "옵션 선택" : undefined,
      context.reportedDetail ? "수치 결과 해석" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  if (locale === "ja-JP") {
    return unique([
      context.benefitPhrase ? "ベネフィット比較" : undefined,
      context.ingredientPhrase ? "処方ポイントの理解" : undefined,
      context.usage ? "使用順序" : undefined,
      context.reviewPhrase ? "使用感判断" : undefined,
      product.options.length > 0 ? "バリエーション選択" : undefined,
      context.reportedDetail ? "数値結果の解釈" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  return unique([
    context.benefitPhrase ? "benefit comparison" : undefined,
    context.ingredientPhrase ? "formula context" : undefined,
    context.usage ? "routine use" : undefined,
    context.reviewPhrase ? "comfort, finish, and review interpretation" : undefined,
    product.options.length > 0 ? "variant selection" : undefined,
    context.reportedDetail ? "reported-result interpretation" : undefined
  ].filter((value): value is string => Boolean(value)));
}

interface DescriptionContext {
  productType: string;
  targetCustomer: string;
  benefits: string[];
  benefitPhrase?: string;
  ingredients: string[];
  ingredientPhrase?: string;
  ingredientDetail?: string;
  ingredientBenefitRelationSupported: boolean;
  usage?: string;
  reviewKeywords: string[];
  reviewPhrase?: string;
  reviewBodies: string[];
  representativeReviews: string[];
  representativeReviewPhrase?: string;
  sourceBackedSentences: string[];
  sourceFactSentences: string[];
  benefitFaqSentence?: string;
  ingredientFaqSentence?: string;
  pageFactPhrase?: string;
  reportedDetail?: string;
}

function createDescriptionContext(
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  optimizedUsageSteps: string[]
): DescriptionContext {
  const rawProductType = resolveProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const claimedBenefits = selectClaimedBenefitSignals(product, locale);
  const benefits = (claimedBenefits.length > 0
    ? claimedBenefits
    : selectPublicBenefitSignals(product, locale, localizedTerms)).slice(0, 5);
  const ingredients = selectLocalizedKeyIngredients(product, locale, 5);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 2).filter((value) => isNarrativeLocaleCompatible(value, locale));
  const reviewKeywords = hasPublicReviewEvidence(product, locale)
    ? selectPublicReviewKeywords(product, locale).filter((value) => isNarrativeLocaleCompatible(value, locale)).slice(0, 5)
    : [];
  const reviewBodies = hasPublicReviewEvidence(product, locale)
    ? selectReviewItems(product, locale).map((item) => item.body).slice(0, 3)
    : [];
  const representativeReviews = selectRepresentativeReviewPhrases(product, locale, 2).filter((value) => isNarrativeLocaleCompatible(value, locale));
  const sourceBackedSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 5).filter((value) => isNarrativeLocaleCompatible(value, locale));
  const sourceFactSentences = selectSourceBackedClaimSentences(product, 5).filter((value) => isNarrativeLocaleCompatible(value, locale));
  const reportedDetails = selectDescriptionEfficacyDetails(product, locale, 2)
    .filter((value) => isNarrativeLocaleCompatible(value, locale));
  const sourceFaq = selectSourceFaqForPublicUse(product.faq, locale, productName, faqStructuredClaimEvidence(product));
  const benefitFaqSentence = selectFaqSentenceForDescription(sourceFaq, locale, ["benefit", "suitability"], 220);
  const ingredientFaqSentence = selectFaqSentenceForDescription(sourceFaq, locale, ["ingredient"], 240);
  const pageFactPhrase = first(sourceFactSentences) ?? first(sourceBackedSentences);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 4);
  const benefitPhrase = formatDescriptionList(benefits, locale, 4);

  return {
    productType,
    targetCustomer: inferTargetCustomer(product, locale),
    benefits,
    benefitPhrase,
    ingredients,
    ingredientPhrase,
    ingredientDetail: formatDescriptionList(ingredientDetails, locale, 2),
    ingredientBenefitRelationSupported: hasExplicitIngredientBenefitRelation(product, ingredients, benefits),
    usage: first(selectUsageInstructions(product).filter((value) => isNarrativeLocaleCompatible(value, locale)))
      ?? first(optimizedUsageSteps.filter((value) => isNarrativeLocaleCompatible(value, locale))),
    reviewKeywords,
    reviewPhrase: formatDescriptionList(reviewKeywords, locale, 4),
    reviewBodies,
    representativeReviews,
    representativeReviewPhrase: formatDescriptionList(representativeReviews, locale, 2),
    sourceBackedSentences,
    sourceFactSentences,
    benefitFaqSentence,
    ingredientFaqSentence,
    pageFactPhrase,
    reportedDetail: first(reportedDetails) ?? (product.description && benefits.length === 0 ? normalizePublicEvidenceText(product.description, locale) : undefined)
  };
}

function hasExplicitIngredientBenefitRelation(
  product: PdpProductSignal,
  selectedIngredients: string[],
  selectedBenefits: string[]
): boolean {
  if (selectedIngredients.length === 0 || selectedBenefits.length === 0) {
    return false;
  }

  return (product.semanticFacts?.ingredientBenefitLinks ?? []).some((link) => {
    const ingredient = cleanSignal(link.ingredient ?? "");
    const outcome = cleanSignal(link.benefit ?? link.effect ?? "");
    if (!ingredient || !outcome) {
      return false;
    }
    const ingredientMatches = selectedIngredients.some((candidate) => descriptionFactMatches(candidate, ingredient));
    const outcomeMatches = selectedBenefits.some((candidate) => (
      descriptionFactMatches(candidate, outcome)
      || semanticFacetsOverlap(benefitSemanticFacets(candidate), benefitSemanticFacets(outcome))
    ));
    return ingredientMatches && outcomeMatches;
  });
}

function descriptionFactMatches(left: string, right: string): boolean {
  const leftKey = signalEntityKey(left);
  const rightKey = signalEntityKey(right);
  return Boolean(leftKey && rightKey)
    && (leftKey === rightKey
      || Math.min(leftKey.length, rightKey.length) >= 4 && (leftKey.includes(rightKey) || rightKey.includes(leftKey)));
}

function semanticFacetsOverlap(left: Set<string>, right: Set<string>): boolean {
  return left.size > 0 && right.size > 0 && Array.from(left).some((facet) => right.has(facet));
}

function isNarrativeLocaleCompatible(value: string, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return false;
  }
  if (locale === "ko-KR") {
    return /[가-힣]/u.test(text) || /[A-Za-z]/u.test(text) && !/[ぁ-んァ-ン]/u.test(text);
  }
  if (locale === "ja-JP") {
    return /[ぁ-んァ-ン一-龥]/u.test(text) && !/[가-힣]/u.test(text);
  }
  return !/[가-힣ぁ-んァ-ン]/u.test(text);
}

function localizeDescriptionIngredientSurface(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value);
  if (locale === "ko-KR" || locale === "ja-JP") {
    return text;
  }
  const withoutForeignParenthetical = text.replace(/\s*\([^)]*[가-힣ぁ-んァ-ン][^)]*\)\s*/gu, " ").replace(/\s+/g, " ").trim();
  const namedTechnology = withoutForeignParenthetical.match(/^([A-Za-z][A-Za-z0-9™®+.-]*)\s*기술$/u)?.[1];
  if (namedTechnology) {
    return `${namedTechnology} technology`;
  }
  const englishMappings: Array<[RegExp, string]> = [
    [/^고밀도\s*세라마이드\s*캡슐$/u, "High-density Ceramide Capsule"],
    [/^세라마이드\s*캡슐$/u, "Ceramide Capsule"],
    [/^세라마이드$/u, "Ceramide"],
    [/^콜레스테롤$/u, "Cholesterol"],
    [/^지방산$/u, "Fatty acids"],
    [/^히알루론산|^하이알루론산/u, "Hyaluronic Acid"],
    [/^징크$/u, "Zinc"],
    [/^나이아신아마이드$/u, "Niacinamide"],
    [/^판테놀$/u, "Panthenol"],
    [/^베타인$/u, "Betaine"],
    [/^프로바이오틱스$/u, "Probiotics"],
    [/^진세노믹스$/u, "Ginsenomics"],
    [/^진생\s*펩타이드$/u, "Ginseng Peptide"],
    [/^진생\s*레티놀$/u, "Ginseng Retinol"]
  ];
  for (const [pattern, replacement] of englishMappings) {
    if (pattern.test(withoutForeignParenthetical)) {
      return replacement;
    }
  }
  return withoutForeignParenthetical && !/[가-힣ぁ-んァ-ン]/u.test(withoutForeignParenthetical)
    ? withoutForeignParenthetical
    : undefined;
}

function selectFaqSentenceForDescription(
  faq: PdpGeoFaqItem[],
  locale: PdpGeoLocale,
  intents: Array<"benefit" | "ingredient" | "usage" | "review" | "suitability" | "evidence">,
  limit: number
): string | undefined {
  for (const item of faq) {
    const itemIntents = classifySourceFaqIntent(item);
    if (!intents.some((intent) => itemIntents.includes(intent))) {
      continue;
    }
    const sentence = first(splitEvidenceIntoSentenceCandidates(item.answer)
      .map((value) => normalizePublicFactText(value))
      .map((value) => trimTrailingSentencePunctuation(value))
      .filter((value) => value.length >= 18 && value.length <= limit)
      .filter((value) => !isLowQualityPublicEvidenceText(value))
      .filter((value) => !isSafetyOrCautionDescriptionSentence(value))
      .filter((value) => !isKoreanMetaNarrationText(value) && !isEnglishMetaNarrationText(value)));
    if (sentence) {
      return locale === "ko-KR" ? sentence : trimTrailingSentencePunctuation(sentence);
    }
  }
  return undefined;
}

function isSafetyOrCautionDescriptionSentence(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:patch\s*test|patch\s*testing|test\s+on\s+a\s+small\s+area|discontinue\s+use|consult\s+(?:a|your)\s+(?:doctor|physician)|caution|warning)/i.test(text)
    || /(?:국소\s*부위|팔\s*안쪽|귀\s*(?:뒤|뒤쪽)|소량\s*테스트|패치\s*테스트|사용\s*전\s*테스트|사용을\s*중지|전문의와\s*상담|주의사항)/u.test(text);
}

function createKoreanProductLeadDescription(productName: string, context: DescriptionContext, fallbackBenefit: string): string {
  const targetCustomer = simplifyKoreanTargetCustomerForSentence(context.targetCustomer);
  if (targetCustomer) {
    return `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(targetCustomer)} 위한 ${context.productType}입니다`;
  }
  const faqLead = createKoreanLeadFromBenefitFaq(productName, context);
  if (faqLead) {
    return faqLead;
  }
  const careFocus = formatKoreanCareFocus(context.benefitPhrase ?? fallbackBenefit);
  return `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(careFocus)} 돕는 ${context.productType}입니다`;
}

function createJapaneseProductLeadDescription(productName: string, context: DescriptionContext): string {
  return isSpecificTargetCustomer(context.targetCustomer, "ja-JP")
    ? `${productName}は${context.targetCustomer}向けの${context.productType}です`
    : `${productName}は${context.productType}です`;
}

function createEnglishProductLeadDescription(productName: string, context: DescriptionContext): string {
  return isSpecificTargetCustomer(context.targetCustomer, "en-US")
    ? `${productName} is ${englishProductTypeWithArticle(context.productType)} for ${context.targetCustomer}`
    : `${productName} is ${englishProductTypeWithArticle(context.productType)}`;
}

function createKoreanLeadFromBenefitFaq(productName: string, context: DescriptionContext): string | undefined {
  const sentence = cleanSignal(context.benefitFaqSentence ?? "");
  if (!sentence || !/[가-힣]/.test(sentence) || hasKoreanSurfaceQualityIssue(sentence)) {
    return undefined;
  }
  // Source FAQ copy can already carry its own product or line subject.
  // Prefixing the current Product entity would create a double subject.
  if (/^[^,.!?。！？]{2,50}(?:은|는|이|가)\s+/u.test(sentence)) {
    return undefined;
  }
  const effectiveMatch = sentence.match(/^(.{4,120}?)(?:에|에\s+특히)?\s*효과적입니다$/);
  if (effectiveMatch?.[1]) {
    return `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(cleanSignal(effectiveMatch[1]))} 케어하는 ${context.productType}입니다`;
  }
  const suitableMatch = sentence.match(/^(.{4,120}?)(?:에게|에)\s*(?:적합|추천)/);
  if (suitableMatch?.[1] && context.benefitPhrase) {
    return `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(formatKoreanCareFocus(context.benefitPhrase))} 돕는 ${context.productType}입니다`;
  }
  return `${appendKoreanTopicParticle(productName)} ${trimTrailingSentencePunctuation(sentence)}`;
}

function createKoreanProductIngredientDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const ingredientPhrase = selectKoreanWebPageIngredientTechnologyPhrase(product, context) ?? context.ingredientPhrase;
  if (!ingredientPhrase && !context.ingredientFaqSentence) {
    return undefined;
  }
  const benefitContext = createKoreanWebPageBenefitContext(product, context);
  const careFocus = benefitContext ?? (context.benefitPhrase ? formatKoreanCareFocus(context.benefitPhrase) : undefined);
  if (ingredientPhrase) {
    const hasCompoundEfficacy = Boolean(context.reportedDetail && hasKoreanGroupedEfficacyNarrative(context.reportedDetail));
    const targetCustomer = !hasCompoundEfficacy && shouldRecommendKoreanWebPageProduct(product, context, careFocus)
      ? context.targetCustomer
      : undefined;
    return createKoreanIngredientBenefitTargetSentence(
      ingredientPhrase,
      careFocus,
      targetCustomer,
      undefined,
      hasCompoundEfficacy ? false : context.ingredientBenefitRelationSupported,
      hasCompoundEfficacy
    );
  }
  return context.ingredientFaqSentence ? ensureKoreanSentence(context.ingredientFaqSentence) : undefined;
}

/**
 * Product descriptions can carry more evidence than WebPage summaries, but
 * only when the normalized product exposes enough independent formula roles.
 * The selector works from routed ingredient/technology facts and explicit
 * source sentences; it does not depend on a product, brand, or ingredient
 * allowlist.
 */
function createKoreanDetailedProductEvidenceDescriptions(
  product: PdpProductSignal,
  context: DescriptionContext
): string[] {
  const directIngredients = selectDirectKoreanProductIngredientSignals(product, 12);
  const technologies = selectKoreanProductTechnologySignals(product, 2);
  const structure = createKoreanProductIngredientStructureDescription(product, directIngredients);
  const relations = selectKoreanProductIngredientTechnologyRelationSentences(
    product,
    directIngredients,
    technologies,
    3
  );
  const hasRichProductEvidence = technologies.length > 0
    || Boolean(structure)
    || relations.length >= 2;

  if (!hasRichProductEvidence) {
    const concise = createKoreanProductIngredientDescription(product, context);
    return concise ? [concise] : [];
  }

  const mainIngredients = selectKoreanDetailedProductMainIngredients(product, directIngredients, 2);
  const ingredientPhrase = formatKoreanNaturalList(mainIngredients);
  const technologyPhrase = first(technologies);
  const benefitContext = createKoreanWebPageBenefitContext(product, context)
    ?? (context.benefitPhrase ? formatKoreanCareFocus(context.benefitPhrase) : undefined);
  const composition = ingredientPhrase && technologyPhrase
    ? `주요 성분은 ${ingredientPhrase}이며, ${appendKoreanSubjectParticle(technologyPhrase)} 적용되어 있습니다`
    : ingredientPhrase
      ? `주요 성분은 ${ingredientPhrase}입니다`
      : technologyPhrase
        ? `${appendKoreanTopicParticle(technologyPhrase)} 제품 포뮬러에 적용되어 있습니다`
        : undefined;

  return unique([
    composition,
    structure,
    ...relations,
    benefitContext ? `${appendKoreanObjectParticle(benefitContext)} 돕습니다` : undefined
  ].filter((value): value is string => Boolean(value)));
}

function selectDirectKoreanProductIngredientSignals(product: PdpProductSignal, limit: number): string[] {
  const evidenceText = roleCoherentIngredientEvidenceTexts(product).join(" ");
  return dedupeIngredientSignals([
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? []),
    ...(product.semanticFacts?.ingredientBenefitLinks ?? [])
      .map((link) => link.ingredient)
      .filter((value): value is string => Boolean(value)),
    // Normalizers may route a sentence such as "X is vitamin B3" to an
    // ingredient-benefit fact without also copying X into the structured
    // ingredient list. Recover concrete entities from the role-coherent
    // evidence so a generic class word (for example "vitamin") cannot win
    // merely because it happened to be present in the raw ingredient array.
    ...roleCoherentIngredientEvidenceTexts(product).flatMap(extractIngredientSubjectCandidates)
  ]
    .flatMap(splitIngredientSignal)
    .map((value) => normalizeKoreanWebPageIngredientTechnologySignal(value, evidenceText))
    .filter((value): value is string => Boolean(value)))
    .filter((value) => isUsefulKeyIngredientSignal(value, product))
    .slice(0, limit);
}

function selectKoreanDetailedProductMainIngredients(
  product: PdpProductSignal,
  candidates: string[],
  limit: number
): string[] {
  const evidence = productIngredientTechnologyEvidenceSentences(product);
  const semanticIngredients = product.semanticFacts?.ingredients ?? [];
  const ranked = candidates
    .map((value, index) => {
      const relationEvidence = evidence.some((sentence) =>
        productEvidenceSentenceContainsFact(sentence, value)
        && hasKoreanIngredientOutcomeRelationship(sentence)
      );
      const semantic = semanticIngredients.some((item) => descriptionFactMatches(item, value));
      const structured = product.ingredients.some((item) => descriptionFactMatches(item, value));
      const technologyLike = /(?:기술|공법|포뮬러|technology|formula)/iu.test(value);
      const trademarkWithoutRelation = /[®™]/u.test(value) && !relationEvidence;
      const genericClassWithConcretePeer = isGenericIngredientClassToken(value)
        && candidates.some((candidate) => candidate !== value
          && !isGenericIngredientClassToken(candidate)
          && evidence.some((sentence) => productEvidenceSentenceContainsFact(sentence, value)
            && productEvidenceSentenceContainsFact(sentence, candidate)));
      const score = Number(relationEvidence) * 10
        + Number(semantic) * 4
        + Number(structured) * 3
        - Number(technologyLike) * 5
        - Number(trademarkWithoutRelation) * 3
        - Number(genericClassWithConcretePeer) * 12;
      return { value, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: string[] = [];
  for (const item of ranked) {
    if (selected.some((existing) => shareIngredientFamily(existing, item.value))) {
      continue;
    }
    selected.push(item.value);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function isGenericIngredientClassToken(value: string): boolean {
  return /^(?:비타민|펩타이드|오일|추출물|발효물|복합체|vitamins?|peptides?|oils?|extracts?|ferments?|complex)$/iu.test(cleanSignal(value));
}

function selectKoreanProductTechnologySignals(product: PdpProductSignal, limit: number): string[] {
  const candidates: string[] = [];
  for (const sentence of productIngredientTechnologyEvidenceSentences(product)) {
    for (const match of sentence.matchAll(/([A-Za-z][A-Za-z0-9®™+.-]{1,31}|[가-힣]{2,24})\s*(기술|공법|포뮬러)/gu)) {
      const name = cleanSignal(match[1] ?? "");
      const kind = cleanSignal(match[2] ?? "");
      const phrase = cleanSignal(`${name} ${kind}`);
      if (!name || !kind || /^(?:제품|상품|피부|핵심|주요|적용|특허)$/u.test(name)) {
        continue;
      }
      candidates.push(phrase);
    }
  }
  candidates.push(...product.ingredients
    .map(stripKoreanPatentQualifier)
    .filter((value) => /(?:기술|공법|포뮬러|technology|formula)/iu.test(value)));
  return dedupePublicListValues(candidates)
    .filter((value) => value.length >= 4 && value.length <= 64)
    .slice(0, limit);
}

function createKoreanProductIngredientStructureDescription(
  product: PdpProductSignal,
  ingredients: string[]
): string | undefined {
  for (const sentence of productIngredientTechnologyEvidenceSentences(product)) {
    if (!/(?:구성|구조|이루어|이뤄|composed|consists?)/iu.test(sentence)) {
      continue;
    }
    const mentioned = ingredients
      .map((ingredient) => ({ ingredient, index: productEvidenceFactIndex(sentence, ingredient) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (mentioned.length < 3) {
      continue;
    }
    const parent = mentioned[0]?.ingredient;
    if (!parent || !new RegExp(`${escapeRegExp(parent)}(?:은|는)\\s+`, "u").test(sentence)) {
      continue;
    }
    const components = mentioned.slice(1)
      .map((item) => item.ingredient)
      .filter((item) => item.length <= 48 && !/\d/u.test(item) && !isIngredientAttributeOrOutcomeSignal(item))
      .slice(0, 3);
    const componentPhrase = formatKoreanNaturalList(components);
    if (components.length >= 2 && componentPhrase) {
      return `${appendKoreanTopicParticle(parent)} ${componentPhrase}로 구성됩니다`;
    }
  }
  return undefined;
}

function selectKoreanProductIngredientTechnologyRelationSentences(
  product: PdpProductSignal,
  ingredients: string[],
  technologies: string[],
  limit: number
): string[] {
  return productIngredientTechnologyEvidenceSentences(product)
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value.length >= 18 && value.length <= 220)
    .filter(({ value }) => /[가-힣]/u.test(value))
    .filter(({ value }) => !hasQuantifiedReportedSignal(value))
    .filter(({ value }) => !certificationOrTestPattern().test(value))
    .filter(({ value }) => !hasActionableApplicationVerb(value))
    .filter(({ value }) => hasKoreanIngredientOutcomeRelationship(value))
    .filter(({ value }) => isKoreanCompleteSentence(trimTrailingSentencePunctuation(value)))
    .map(({ value, index }) => {
      const ingredientMatch = ingredients.some((ingredient) => productEvidenceSentenceContainsFact(value, ingredient));
      const technologyMatch = technologies.some((technology) => productEvidenceSentenceContainsFact(value, technology));
      const compositionOnly = /(?:구조의|로\s*구성|으로\s*구성|이루어|이뤄)/u.test(value);
      const metaNarration = /(?:설명|안내)(?:되어|합니다|됩니다)/u.test(value);
      const score = Number(ingredientMatch) * 6
        + Number(technologyMatch) * 5
        + 4
        + Number(value.length <= 130) * 2
        - Number(compositionOnly) * 6
        - Number(metaNarration) * 2;
      return { value, index, score, matched: ingredientMatch || technologyMatch };
    })
    .filter((item) => item.matched)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => normalizeKoreanProductRelationSentence(item.value))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.findIndex((candidate) => signalEntityKey(candidate) === signalEntityKey(value)) === index)
    .slice(0, limit);
}

function productIngredientTechnologyEvidenceSentences(product: PdpProductSignal): string[] {
  const reviewKeys = new Set(product.reviews.items.map((item) => signalEntityKey(item.body)).filter(Boolean));
  return unique([
    product.description,
    ...(product.semanticFacts?.evidenceSentences ?? []),
    ...(product.semanticFacts?.ingredientBenefitLinks ?? [])
      .flatMap((link) => [link.sentence, link.sourceText])
      .filter((value): value is string => Boolean(value)),
    ...product.sourceTexts
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap(splitEvidenceIntoSentenceCandidates)
    .map(cleanSignal)
    .filter(Boolean)
    .filter((value) => !reviewKeys.has(signalEntityKey(value))));
}

function hasKoreanIngredientOutcomeRelationship(value: string): boolean {
  return /(?:도와|돕|지원|기여|개선|강화|보완|보습|수분|진정|탄력|주름|장벽|효과적|제공)/u.test(value)
    && /(?:성분|원료|캡슐|기술|공법|포뮬러|복합체|비타민|세라마이드|펩타이드|레티놀|추출물|[®™])/u.test(value);
}

function productEvidenceSentenceContainsFact(sentence: string, fact: string): boolean {
  return productEvidenceFactIndex(sentence, fact) >= 0;
}

function productEvidenceFactIndex(sentence: string, fact: string): number {
  const normalizedSentence = cleanSignal(sentence).toLocaleLowerCase().replace(/\s+/gu, "");
  const normalizedFact = cleanSignal(fact)
    .toLocaleLowerCase()
    .replace(/\s*(?:성분|기술|공법|포뮬러)$/u, "")
    .replace(/\s+/gu, "");
  return normalizedFact.length >= 2 ? normalizedSentence.indexOf(normalizedFact) : -1;
}

function normalizeKoreanProductRelationSentence(value: string): string | undefined {
  const text = trimTrailingSentencePunctuation(cleanSignal(value))
    .replace(/민감피부/gu, "민감 피부")
    .replace(/피부장벽/gu, "피부 장벽")
    .replace(/장벽보습/gu, "장벽 보습")
    .replace(/강화시켜\s*줍니다$/u, "강화하는 데 도움을 줍니다")
    .replace(/효과적인\s*성분(?:이라고|으로)?\s*(?:설명|안내)(?:되어\s*있습니다|됩니다|합니다)$/u, "효과적인 성분입니다")
    .replace(/([^.!?。！？]+?)(?:이라고|라고)\s*(?:설명|안내)되어\s*있습니다$/u, "$1입니다")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isLowQualityPublicEvidenceText(text) || hasTruncationMarker(text)) {
    return undefined;
  }
  return ensurePublicSentence(text, "ko-KR");
}

function createProductSafetyEvidenceDescription(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const signals = selectFunctionalCertificationSignals(product, locale, locale === "ko-KR" ? 8 : 6);
  if (signals.length === 0) {
    return undefined;
  }
  if (locale === "ko-KR") {
    const testNames = signals
      .map((value) => trimTrailingSentencePunctuation(value).replace(/\s*완료$/u, "").trim())
      .filter(Boolean);
    const phrase = formatKoreanNaturalList(testNames);
    return phrase ? `이 제품은 ${appendKoreanObjectParticle(phrase)} 완료했습니다` : undefined;
  }
  const phrase = formatDescriptionList(signals, locale, 6);
  if (!phrase) {
    return undefined;
  }
  return locale === "ja-JP"
    ? `本品は${phrase}の試験情報があります`
    : `The product's documented testing includes ${phrase}`;
}

function createKoreanDetailedProductReviewDescription(context: DescriptionContext): string | undefined {
  return createKoreanReviewSummaryDescription(context)?.replace(/^고객\s*리뷰에서는/u, "실제 고객 리뷰에서는");
}

function formatKoreanCareFocus(value: string): string {
  const items = cleanSignal(value)
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /(?:케어|개선|강화|진정|세정|컨트롤|리프팅)$/.test(item) ? item : `${item} 케어`);
  return formatKoreanListForSentence(unique(items).join(", "));
}

function formatKoreanProductTargetCustomerDative(value: string): string | undefined {
  const target = simplifyKoreanTargetCustomerForSentence(value);
  if (!target || /^고객$/u.test(target)) {
    return undefined;
  }
  return `${target}에게`;
}

function createJapaneseIngredientTechnologyProductSentence(
  ingredientPhrase: string,
  benefitPhrase?: string,
  detail?: string,
  relationSupported = false
): string {
  const ingredient = stripPatentApplicationQualifier(ingredientPhrase);
  const role = inferIngredientTechnologyRole(ingredientPhrase);
  const benefit = cleanSignal(benefitPhrase ?? "");
  const detailPhrase = detail ? normalizeFormulaDetailText(detail) : undefined;
  const composition = role === "formula"
    ? `${ingredient}を採用した処方です`
    : role === "mixed"
      ? `${ingredient}をもとにした処方です`
      : `${ingredient}を配合した処方です`;
  const predicate = benefit
    ? relationSupported
      ? `${trimTrailingSentencePunctuation(composition)}。${benefit}をサポートします`
      : `${trimTrailingSentencePunctuation(composition)}。主なベネフィットは${benefit}です`
    : composition;

  return detailPhrase
    ? `${predicate} 処方の補足情報は${detailPhrase}です`
    : predicate;
}

function createEnglishIngredientTechnologyProductSentence(
  subject: string,
  ingredientPhrase: string,
  benefitPhrase?: string,
  detail?: string,
  relationSupported = false
): string {
  const ingredient = stripPatentApplicationQualifier(ingredientPhrase);
  const role = inferIngredientTechnologyRole(ingredientPhrase);
  const benefit = benefitPhrase?.replace(/\bskin barrier support\b/gi, "skin barrier health");
  const benefitClause = benefit && relationSupported ? ` to support ${benefit}` : "";
  const detailSentence = detail ? first(splitEvidenceIntoSentenceCandidates(normalizeFormulaDetailText(detail))) : undefined;
  const detailClause = detailSentence ? `. ${capitalizeFirst(trimTrailingSentencePunctuation(detailSentence))}` : "";
  const productSubject = role === "formula" && /^the\s+formula$/i.test(subject) ? "The product" : subject;
  const sentence = role === "formula"
    ? `${productSubject} uses ${ingredient}${benefitClause || " as a formula technology"}`
    : role === "mixed"
      ? `${subject} combines ${ingredient}${benefitClause}`
      : `${subject} includes ${ingredient}${benefitClause}`;

  const nonCausalBenefit = benefit && !relationSupported ? `. The product's documented benefit is ${benefit}` : "";
  return `${sentence}${nonCausalBenefit}${detailClause}`;
}

function createProductIngredientDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (!context.ingredientPhrase && !context.ingredientDetail) {
    return undefined;
  }
  const benefitSupportPhrase = context.benefitPhrase;

  switch (locale) {
    case "ko-KR":
      if (!context.ingredientPhrase && context.ingredientDetail) {
        return `포뮬러 설명은 ${normalizeFormulaDetailText(context.ingredientDetail)} 내용을 중심으로 합니다`;
      }
      return context.ingredientDetail
        ? createKoreanIngredientDetailDescription(context.ingredientPhrase ?? "", context.ingredientDetail)
        : `주요 성분/기술은 ${context.ingredientPhrase}입니다`;
    case "ja-JP":
      if (!context.ingredientPhrase && context.ingredientDetail) {
        return `処方の補足情報は${normalizeFormulaDetailText(context.ingredientDetail)}です`;
      }
      return createJapaneseIngredientTechnologyProductSentence(
        context.ingredientPhrase ?? "",
        benefitSupportPhrase,
        context.ingredientDetail,
        context.ingredientBenefitRelationSupported
      );
    case "en-GB":
    case "en-US":
    default:
      if (!context.ingredientPhrase && context.ingredientDetail) {
        return `The formula includes ${formatEnglishFactComplement(normalizeFormulaDetailText(context.ingredientDetail))}`;
      }
      return createEnglishIngredientTechnologyProductSentence(
        "The formula",
        context.ingredientPhrase ?? "",
        benefitSupportPhrase,
        context.ingredientDetail,
        context.ingredientBenefitRelationSupported
      );
  }
}

function createProductUsageDescription(locale: PdpGeoLocale, usage?: string): string | undefined {
  const usageContext = formatUsageForProductDescription(usage, locale);
  if (!usageContext) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const cleanUsage = trimTrailingSentencePunctuation(usageContext);
    return isKoreanCompleteSentence(cleanUsage) ? cleanUsage : `${cleanUsage} 사용합니다`;
  }

  return fallback(locale, {
    "ko-KR": `${trimTrailingSentencePunctuation(usageContext)} 사용합니다`,
    "ja-JP": `使い方は${usageContext}として整理できます`,
    "en-US": usageContext,
    "en-GB": usageContext
  });
}

function createProductEvidenceDescription(locale: PdpGeoLocale, evidence: string): string {
  const cleanEvidence = normalizeEvidenceText(truncateAtCompleteSentence(evidence, 420));
  if ((locale === "en-US" || locale === "en-GB") && isDescriptionEfficacyEvidence(cleanEvidence)) {
    return createEnglishDescriptionEfficacySentence(cleanEvidence, locale);
  }
  const assessment = cleanEvidence.match(/^In an? ([^,]+),\s*(.+)$/i);

  if (assessment) {
    const context = assessment[1] ?? "";
    const topics = formatDescriptionList(extractEvidenceTopics(cleanEvidence), locale, 3);
    switch (locale) {
      case "ko-KR":
        return topics ? `${context} 결과는 ${topics} 효과를 뒷받침합니다` : `${context} 결과를 바탕으로 한 상품 정보입니다`;
      case "ja-JP":
        return topics ? `確認できる${context}の結果は${topics}の根拠を補足します` : `確認できる結果は${context}に基づきます`;
      case "en-GB":
      case "en-US":
      default:
        return topics ? `In ${indefiniteArticle(context)} ${context}, the product showed ${topics}` : `The product has reported results from ${indefiniteArticle(context)} ${context}`;
    }
  }

  if (locale === "ko-KR") {
    const contextualClause = normalizeReportedPropertyClause(evidence, locale);
    if (contextualClause && hasContextualReportedSignal(contextualClause)) {
      return createKoreanDescriptionEvidenceSentence(contextualClause);
    }
    const metricFact = createEvidenceMetricFact(evidence, locale);
    const evidenceSentence = metricFact ? createKoreanEvidenceFactSentence(metricFact) : createKoreanEvidenceContentSentence(cleanEvidence);
    return isKoreanCompleteSentence(evidenceSentence)
      ? evidenceSentence
      : `${evidenceSentence}를 참고할 수 있습니다`;
  }

  return fallback(locale, {
    "ko-KR": `${cleanEvidence}를 바탕으로 한 상품 정보입니다`,
    "ja-JP": `確認できる商品情報は${cleanEvidence}です`,
    "en-US": `The product is described with ${formatEnglishFactComplement(cleanEvidence)}`,
    "en-GB": `The product is described with ${formatEnglishFactComplement(cleanEvidence)}`
  });
}

function createWebPageEvidenceDescription(locale: PdpGeoLocale, evidence: string): string {
  const cleanEvidence = normalizeEvidenceText(truncateAtCompleteSentence(evidence, 420));
  if ((locale === "en-US" || locale === "en-GB") && isDescriptionEfficacyEvidence(cleanEvidence)) {
    return createEnglishDescriptionEfficacySentence(cleanEvidence, locale);
  }
  const topics = formatDescriptionList(extractEvidenceTopics(cleanEvidence), locale, 3);
  if (locale === "ko-KR") {
    const contextualClause = normalizeReportedPropertyClause(evidence, locale);
    if (contextualClause && hasContextualReportedSignal(contextualClause)) {
      return createKoreanDescriptionEvidenceSentence(contextualClause);
    }
    const metricFact = createEvidenceMetricFact(evidence, locale);
    const evidenceSentence = metricFact ? createKoreanEvidenceFactSentence(metricFact) : createKoreanEvidenceContentSentence(cleanEvidence);
    return createKoreanWebPageEvidenceDescription(evidenceSentence);
  }
  if (locale === "ja-JP") {
    const metricFact = createEvidenceMetricFact(evidence, locale);
    const evidenceSentence = metricFact ? createJapaneseWebPageEvidenceDescription(metricFact) : createJapaneseWebPageEvidenceDescription(cleanEvidence);
    return topics
      ? `測定/評価情報では${topics}に関する結果も扱います`
      : evidenceSentence;
  }
  return fallback(locale, {
    "ko-KR": `확인된 결과/정보로 ${cleanEvidence}를 참고할 수 있습니다`,
    "ja-JP": topics ? `測定/評価情報では${topics}に関する結果も扱います` : createJapaneseWebPageEvidenceDescription(cleanEvidence),
    "en-US": topics ? `This product page covers reported results for ${topics}` : `This product page covers ${formatEnglishFactComplement(cleanEvidence)}`,
    "en-GB": topics ? `This product page covers reported results for ${topics}` : `This product page covers ${formatEnglishFactComplement(cleanEvidence)}`
  });
}

function createEnglishDescriptionEfficacySentence(evidence: string, locale: "en-US" | "en-GB"): string {
  const text = trimTrailingSentencePunctuation(normalizeEvidenceText(evidence)
    .replace(/^(?:Reported result|Consumer assessment)\s*:\s*/i, ""));
  const assessment = text.match(/^(In an? [^,]+),\s*(.+)$/i);
  if (assessment?.[1] && assessment[2]) {
    const firstOutcome = assessment[2]
      .split(/\s*;\s*(?=\d+(?:\.\d+)?%)/i)[0]
      ?.trim();
    if (firstOutcome) {
      return ensurePublicSentence(`${assessment[1]}, ${firstOutcome}`, locale);
    }
  }
  const concise = text.length > 300 ? truncateAtCompleteSentence(text, 300) : text;
  return ensurePublicSentence(concise, locale);
}

function normalizeEvidenceText(value: string): string {
  return trimTrailingSentencePunctuation(normalizePublicFactText(value)
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\bAGREE\b/g, "agreed")
    .replace(/\bAGREED\b/g, "agreed")
    .replace(/([A-Za-z])\d+(?=\s+\d+(?:\.\d+)?%)/g, "$1.")
    .replace(/([A-Za-z])\d+(?=\s*(?:Home usage|Self-assess|Instrumental|Clinical))/gi, "$1. ")
    .replace(/\b\d+\s*(?=(?:Home usage|Self-assess|Instrumental|Clinical))/gi, "")
    .replace(/\b(\d)\s*based\b/gi, "$1 based")
    .replace(/\s+/g, " ")
    .trim());
}

function extractEvidenceTopics(evidence: string): string[] {
  const text = normalizeEvidenceText(evidence);
  const topics: string[] = [];
  if (/gentle|irritation|non[-\s]?stripping/i.test(text)) {
    topics.push("foam gentleness");
  }
  if (/makeup|residue|impurit|dust|pollution|cleanse/i.test(text)) {
    topics.push("makeup-residue cleansing");
  }
  if (/hydrat|moist|dryness/i.test(text)) {
    topics.push("post-cleanse hydration");
  }
  if (/firm|elastic|resilien|wrinkle|fine line/i.test(text)) {
    topics.push("firmness and visible-aging care");
  }
  if (/barrier|ceramide/i.test(text)) {
    topics.push("skin-barrier support");
  }
  if (/oil|sebum/i.test(text)) {
    topics.push("oil-control context");
  }
  return unique(topics);
}

function createEvidenceMetricFact(evidence: string | undefined, locale: PdpGeoLocale): string | undefined {
  if (!evidence) {
    return undefined;
  }
  const cleanEvidence = normalizeEvidenceText(evidence);
  if (isFormattedEvidenceSummary(cleanEvidence) || isStructuredMetricSummary(cleanEvidence)) {
    return cleanEvidence;
  }
  const formattedEvidence = formatReportedEvidenceDetail(cleanEvidence, locale);
  if (formattedEvidence) {
    return formattedEvidence;
  }
  const metricClauses = extractEvidenceMetricClauses(cleanEvidence).slice(0, 3);
  if (metricClauses.length === 0) {
    const topics = formatDescriptionList(extractEvidenceTopics(cleanEvidence), locale, 3);
    return topics ? fallback(locale, {
      "ko-KR": `관련 케어 주제는 ${topics}입니다`,
      "ja-JP": `確認根拠: ${topics}`,
      "en-US": `Care topics: ${topics}`,
      "en-GB": `Care topics: ${topics}`
    }) : cleanEvidence;
  }

  const metrics = formatDescriptionList(metricClauses, locale, 3);
  return fallback(locale, {
    "ko-KR": `시험/평가 결과로 ${metrics}가 보고되었습니다`,
    "ja-JP": `確認指標: ${metrics}`,
    "en-US": `Consumer assessment: ${metrics}`,
    "en-GB": `Consumer assessment: ${metrics}`
  });
}

function isFormattedEvidenceSummary(value: string): boolean {
  return /^In an? .+,\s+\d+(?:\.\d+)?%\s+of\s+participants\s+agreed\s+that\b/i.test(value);
}

function isStructuredMetricSummary(value: string): boolean {
  return /^(?:Reported result|Consumer assessment|확인 지표|확인 근거|측정 결과|평가 지표|試験結果|確認指標|確認根拠):\s+/i.test(value);
}

function extractEvidenceMetricClauses(evidence: string): string[] {
  const cleanEvidence = normalizeEvidenceText(evidence);
  const koreanMetricClauses = extractKoreanEvidenceMetricClauses(cleanEvidence);
  if (koreanMetricClauses.length > 0) {
    return koreanMetricClauses;
  }
  const signedImprovementClauses = extractSignedImprovementMetricClauses(cleanEvidence);
  if (signedImprovementClauses.length > 0) {
    return signedImprovementClauses;
  }

  if (!hasAgreementAssessmentWording(cleanEvidence)) {
    return [];
  }
  const matches = Array.from(cleanEvidence.matchAll(/(\d+(?:\.\d+)?%)\s+(?:(?:of\s+)?(?:participants|users|subjects|women|men)\s+)?(?:users?\s+)?(?:(?:had\s+visible\s+improvement\s+in|showed\s+improvement\s+in|agreed)\s+(?:that\s+)?)?([^.;]+?)(?=(?:\.\s*)?\d+(?:\.\d+)?%|\.\s*(?:Home usage|Self-assess|Instrumental|Clinical|$)|;|$)/gi));
  return matches.flatMap((match) => {
    const percentage = match[1]?.trim();
    const claim = match[2]?.trim();
    return percentage && claim ? [`${percentage} agreed ${normalizeEvidenceClaimPhrase(claim)}`] : [];
  });
}

function hasAgreementAssessmentWording(value: string): boolean {
  return /\bagree(?:d)?\b|동의|응답|만족/i.test(value);
}

function extractKoreanEvidenceMetricClauses(evidence: string): string[] {
  const text = normalizeKoreanEvidenceText(evidence);
  if (!/[가-힣]/.test(text) || !/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(text)) {
    return [];
  }

  const clauses = [
    ...extractKoreanParallelTimedMetricClauses(text),
    ...extractKoreanTimedMetricClauses(text),
    ...extractKoreanSegmentMetricClauses(text)
  ];
  if (clauses.length === 0) {
    clauses.push(...extractKoreanStandaloneMetricClauses(text));
  }

  return unique(clauses.map(normalizeKoreanMetricClause).filter((value): value is string => Boolean(value))).slice(0, 6);
}

function normalizeKoreanEvidenceText(value: string): string {
  return normalizeEvidenceText(value)
    .replace(/[☑□■●◆]/g, " ")
    .replace(/\s*([|/])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKoreanParallelTimedMetricClauses(text: string): string[] {
  const pattern = /([^.;。！？☑]{0,48}?)(사용\s*직후)\s*(\d+(?:\.\d+)?\s*(?:%|배))\s*[,，]\s*(사용\s*\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)\s*(\d+(?:\.\d+)?\s*(?:%|배))\s*(회복|개선|감소|증가)/g;
  const clauses: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const subject = cleanKoreanMetricSubject(match[1] ?? "");
    const firstTiming = normalizeKoreanTimingPhrase(match[2] ?? "");
    const firstMetric = normalizeKoreanMetricValue(match[3] ?? "");
    const secondTiming = normalizeKoreanTimingPhrase(match[4] ?? "");
    const secondMetric = normalizeKoreanMetricValue(match[5] ?? "");
    const outcome = match[6]?.trim();
    if (!outcome) {
      continue;
    }
    if (firstMetric) {
      clauses.push(compactKoreanMetricClause([firstTiming, subject, firstMetric, outcome]));
    }
    if (secondMetric) {
      clauses.push(compactKoreanMetricClause([secondTiming, subject, secondMetric, outcome]));
    }
  }
  return clauses;
}

function extractKoreanTimedMetricClauses(text: string): string[] {
  const pattern = /((?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|(?:\d+(?:\.\d+)?\s*(?:시간|일|주).{0,20})?(?:\d+\s*회\s*)?(?:사용|도포|측정)\s*후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤))\s*[,·|/]?\s*([^.;。！？☑]{0,60}?)(\d+(?:\.\d+)?\s*(?:%|배))\s*(?:즉시\s*)?(회복|개선|감소|증가)/g;
  return Array.from(text.matchAll(pattern)).flatMap((match) => {
    const timing = normalizeKoreanTimingPhrase(match[1] ?? "");
    const subject = cleanKoreanMetricSubject(match[2] ?? "");
    const metric = normalizeKoreanMetricValue(match[3] ?? "");
    const outcome = match[4]?.trim();
    if (!metric || !outcome) {
      return [];
    }
    return [compactKoreanMetricClause([timing, subject, metric, outcome])];
  });
}

function extractKoreanSegmentMetricClauses(text: string): string[] {
  const segmentPattern = /((?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|(?:\d+(?:\.\d+)?\s*(?:시간|일|주).{0,20})?(?:\d+\s*회\s*)?(?:사용|도포|측정)\s*후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤))([^.;。！？☑]{0,140}?)(회복|개선|감소|증가)/g;
  const clauses: string[] = [];
  for (const segment of text.matchAll(segmentPattern)) {
    const timing = normalizeKoreanTimingPhrase(segment[1] ?? "");
    const body = segment[2] ?? "";
    const outcome = segment[3]?.trim();
    if (!outcome) {
      continue;
    }
    const metricItems = Array.from(body.matchAll(/([가-힣A-Za-z][가-힣A-Za-z\s/·&-]{0,24}?)\s*(\d+(?:\.\d+)?\s*(?:%|배))/g));
    for (const item of metricItems) {
      const subject = cleanKoreanMetricSubject(item[1] ?? "");
      const metric = normalizeKoreanMetricValue(item[2] ?? "");
      if (metric) {
        clauses.push(compactKoreanMetricClause([timing, subject, metric, outcome]));
      }
    }
  }
  return clauses;
}

function extractKoreanStandaloneMetricClauses(text: string): string[] {
  if (!/(?:테스트|시험|결과|ex\s*vivo|in\s*vitro|임상|인체\s*적용)/i.test(text)) {
    return [];
  }
  const metric = Array.from(text.matchAll(/\d+(?:\.\d+)?\s*(?:%|배)/g)).map((match) => normalizeKoreanMetricValue(match[0])).at(-1);
  if (!metric) {
    return [];
  }
  const timing = extractKoreanTimingPhrase(text);
  const subject = extractKoreanMetricSubjectFromEvidence(text);
  return [compactKoreanMetricClause([timing, subject, metric, "결과"])];
}

function normalizeKoreanMetricValue(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function normalizeKoreanMetricClause(value: string): string | undefined {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  if (!normalized || !/(?:\d+(?:\.\d+)?%|\d+(?:\.\d+)?배)/.test(normalized)) {
    return undefined;
  }
  return normalized.replace(/\bagreed\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

function compactKoreanMetricClause(parts: Array<string | undefined>): string {
  return parts.map((part) => cleanSignal(part ?? "")).filter(Boolean).join(" ");
}

function normalizeKoreanTimingPhrase(value: string): string | undefined {
  const text = cleanSignal(value)
    .replace(/\s+/g, " ")
    .replace(/^사용\s*(\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)$/u, "사용 $1")
    .trim();
  return text || undefined;
}

function cleanKoreanMetricSubject(value: string): string | undefined {
  const text = cleanSignal(value)
    .replace(/^(?:[,·|/]|및|와|과|에서|의|에|후|전|\s)+/g, "")
    .replace(/(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/g, "")
    .replace(/\b(?:and|with)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 32 || /^(?:확인|지표|결과|사용|전|후)$/.test(text)) {
    return undefined;
  }
  return text;
}

function extractKoreanTimingPhrase(text: string): string | undefined {
  const applicationTiming = text.match(/(?:1\s*회\s*도포\s*후\s*)?\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)?/);
  if (applicationTiming?.[0]) {
    return cleanSignal(applicationTiming[0]);
  }
  const usageTiming = text.match(/(?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/);
  return usageTiming?.[0] ? cleanSignal(usageTiming[0]) : undefined;
}

function extractKoreanMetricSubjectFromEvidence(text: string): string | undefined {
  const knownSubject = first([
    /세라마이드/i.test(text) ? "세라마이드" : undefined,
    /장벽/.test(text) ? "피부 장벽" : undefined,
    /수분량|수분/.test(text) ? "수분량" : undefined,
    /각질량|각질/.test(text) ? "각질량" : undefined,
    /피부결/.test(text) ? "피부결" : undefined,
    /투명도/.test(text) ? "투명도" : undefined
  ]);
  if (knownSubject) {
    return knownSubject;
  }
  const beforeMetric = text.split(/\d+(?:\.\d+)?\s*(?:%|배)/)[0] ?? "";
  const tail = beforeMetric.match(/([가-힣A-Za-z][가-힣A-Za-z\s/·&-]{1,24})$/)?.[1];
  return tail ? cleanKoreanMetricSubject(tail) : undefined;
}

function extractSignedImprovementMetricClauses(evidence: string): string[] {
  const matches = Array.from(evidence.matchAll(/([+\-−]?\d+(?:\.\d+)?%)\s+(improves?|improved|strengthens?|strengthened|increases?|increased)\s+(.+?)(?=(?:\s+[+\-−]?\d+(?:\.\d+)?%\s+(?:improves?|improved|strengthens?|strengthened|increases?|increased)\b)|\s+\d+\s*(?:Instrumental|Home usage|Self-assess|Clinical)|[.;]|$)/gi));
  return matches.flatMap((match) => {
    const percent = normalizeSignedPercent(match[1] ?? "");
    const verb = match[2] ?? "";
    const claim = normalizeSignedImprovementClaim(match[3] ?? "");
    return percent && claim ? [formatSignedImprovementMetricClause(percent, verb, claim)] : [];
  });
}

function normalizeSignedPercent(value: string): string {
  return value.replace(/^−/, "-").replace(/\s+/g, "").trim();
}

function normalizeSignedImprovementClaim(value: string): string | undefined {
  const cleaned = removeEvidenceFootnoteMarkers(value)
    .replace(/\bTHE\s+LOOK\s+OF\s+/gi, "the look of ")
    .replace(/\bSKIN\s+ELASTICITY\b/gi, "skin elasticity")
    .replace(/\bMOISTURE\s+BARRIER\b/gi, "moisture barrier")
    .replace(/\bHYDRATION\b/gi, "hydration")
    .replace(/\s+/g, " ")
    .replace(/[.;,\s]+$/g, "")
    .trim();

  if (!cleaned) {
    return undefined;
  }

  if (isRawUppercaseOcrFragment(cleaned)) {
    const canonicalTerms = extractCanonicalBenefitTerms(cleaned);
    return canonicalTerms.length > 0 ? formatDescriptionList(canonicalTerms, "en-US", 3) ?? canonicalTerms.join(", ") : undefined;
  }

  return lowercaseFirst(cleaned);
}

function formatSignedImprovementMetricClause(percent: string, verb: string, claim: string): string {
  if (/^strengthen/i.test(verb)) {
    return `${percent} strengthened ${claim}`;
  }
  if (/^increase/i.test(verb)) {
    return `${percent} increased ${claim}`;
  }
  return `${percent} improvement in ${claim}`;
}

function normalizeEvidenceClaimPhrase(value: string): string {
  const cleanValue = removeEvidenceFootnoteMarkers(value)
    .replace(/\b(?:of\s+)?(?:participants|users|subjects|women|men)\s+/gi, "")
    .replace(/\b(?:had\s+visible\s+improvement\s+in|showed\s+improvement\s+in|agreed(?:\s+that)?)\b/gi, "")
    .replace(/[,\s;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const canonicalTerms = extractCanonicalBenefitTerms(cleanValue);
  const hasOcrNoise = /[A-Z]{4,}.*[A-Z]{4,}|(?:serum|cream|sulwhasoo|sérum|activateur|premiers soins)/i.test(cleanValue);
  if (canonicalTerms.length > 1) {
    return formatDescriptionList(canonicalTerms, "en-US", 4) ?? canonicalTerms.join(", ");
  }
  if (/fine\s+lines?/i.test(cleanValue) && canonicalTerms.includes("fine lines and wrinkles")) {
    return "fine lines and wrinkles";
  }
  if (/skin\s+texture|smoother/i.test(cleanValue) && canonicalTerms.includes("smooth texture")) {
    return "smooth texture";
  }
  if (hasOcrNoise && canonicalTerms.length > 0) {
    return formatDescriptionList(canonicalTerms, "en-US", 4) ?? canonicalTerms.join(", ");
  }
  const normalized = /[A-Z]{3,}/.test(cleanValue) && !/[a-z]/.test(cleanValue)
    ? cleanValue.toLowerCase()
    : lowercaseFirst(cleanValue);
  return normalized
    .replace(/\bproduct\b/g, "the product")
    .replace(/\bfoam\b/g, "the foam")
    .replace(/\bskin\b/g, "skin");
}

function formatReportedEvidenceDetail(evidence: string, locale: PdpGeoLocale): string | undefined {
  if (locale === "ko-KR") {
    const multiMetricDetail = formatKoreanMultiMetricEvidenceDetail(evidence);
    if (multiMetricDetail) {
      return multiMetricDetail;
    }
    const koreanMetricClauses = extractKoreanEvidenceMetricClauses(evidence).slice(0, 4);
    if (koreanMetricClauses.length > 0) {
      const metrics = koreanMetricClauses.join("; ");
      const context = extractKoreanEvidenceAssessmentContext(evidence);
      return context ? `${context} 기준 평가 지표: ${metrics}` : `평가 지표: ${metrics}`;
    }
  }

  const metricClauses = extractEvidenceMetricClauses(evidence).slice(0, 4);
  if (metricClauses.length === 0) {
    return undefined;
  }
  const context = extractEvidenceAssessmentContext(evidence);
  const metrics = locale === "ko-KR"
    ? metricClauses.join("; ")
    : metricClauses.join("; ");

  if (!context) {
    return fallback(locale, {
      "ko-KR": `평가 지표: ${metrics}`,
      "ja-JP": `確認指標: ${metrics}`,
      "en-US": `Consumer assessment: ${metrics}`,
      "en-GB": `Consumer assessment: ${metrics}`
    });
  }

  return fallback(locale, {
    "ko-KR": `${context} 기준 평가 지표: ${metrics}`,
    "ja-JP": `${context}に基づく確認指標: ${metrics}`,
    "en-US": `In ${context}, ${metrics}`,
    "en-GB": `In ${context}, ${metrics}`
  });
}

function formatKoreanMultiMetricEvidenceDetail(evidence: string): string | undefined {
  const text = normalizeKoreanEvidenceText(evidence);
  if (!/[가-힣]/.test(text) || !/%/.test(text)) {
    return undefined;
  }

  const cleansingMetrics = unique([
    ...Array.from(text.matchAll(/초미세먼지\s*(\d+(?:\.\d+)?%)\s*세정/g)).map((match) => `초미세먼지 ${match[1]} 세정`),
    ...Array.from(text.matchAll(/모공\s*속\s*노폐물\s*(\d+(?:\.\d+)?%)\s*세정/g)).map((match) => `모공 속 노폐물 ${match[1]} 세정`)
  ]);
  const bubbleSize = text.match(/(?:포밍\s*클렌저\s*)?버블\s*평균\s*사이즈\s*(\d+(?:\.\d+)?\s*um)/i)?.[1]?.replace(/\s+/g, "");
  const ceramideMetrics = /세라마이드\s*함량|Ceramides\s*total/i.test(text)
    ? Array.from(text.matchAll(/\d+(?:\.\d+)?%/g)).map((match) => match[0]).slice(-3)
    : [];
  const sample = text.match(/만\s*\d{2}\s*~\s*\d{2}세(?:의)?\s*성인\s*(?:여성|남성)?\s*\d+\s*명\s*대상/)?.[0]
    ?? text.match(/\d+\s*명\s*대상/)?.[0];
  const period = text.match(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/)?.[0];
  const context = [sample, period ? `시험기간 ${period}` : undefined, /개인차\s*있음/.test(text) ? "개인차 있음" : undefined]
    .filter(Boolean)
    .join(", ");
  const sentences: string[] = [];

  if (cleansingMetrics.length > 0) {
    sentences.push(`세정 시험 정보는 ${cleansingMetrics.join(", ")}${context ? ` (${context})` : ""}로 표시됩니다`);
  }
  if (bubbleSize) {
    sentences.push(`포밍 클렌저 버블 평균 사이즈는 ${bubbleSize}로 확인됩니다`);
  }
  if (ceramideMetrics.length >= 3) {
    sentences.push(`피부 각질층 세라마이드 함량 분석은 사용 직후 ${ceramideMetrics[0]}, 사용 2주 후 ${ceramideMetrics[1]}, 사용 4주 후 ${ceramideMetrics[2]}로 표시됩니다${/in\s*vitro/i.test(text) ? " (in vitro 시험 결과)" : ""}`);
  }

  return sentences.length > 0 ? sentences.join(". ") : undefined;
}

function extractKoreanEvidenceAssessmentContext(evidence: string): string | undefined {
  const text = normalizeKoreanEvidenceText(evidence);
  const assessment = first([
    /Tape\s*Stripping|외부자극/i.test(text) ? "외부자극/Tape Stripping 테스트" : undefined,
    /ex\s*vivo/i.test(text) ? "ex vivo 테스트" : undefined,
    /in\s*vitro/i.test(text) ? "in vitro 테스트" : undefined,
    /인체\s*적용|임상/.test(text) ? "인체적용시험" : undefined,
    /자가\s*평가|설문|응답/.test(text) ? "자가평가" : undefined,
    /테스트|시험|결과/.test(text) ? "상품 상세 테스트" : undefined
  ]);
  const sample = text.match(/\b\d{2,4}\s*(?:명|인|참여자|대상|사용자|여성|남성)\b/)?.[0];
  const timing = extractKoreanTimingPhrase(text);
  return [assessment, sample ? `${sample} 대상` : undefined, timing ? `${timing} 시점` : undefined]
    .filter(Boolean)
    .join(", ") || undefined;
}

function extractEvidenceAssessmentContext(evidence: string): string | undefined {
  const text = normalizeEvidenceText(evidence);
  const assessment = first([
    /home usage test survey/i.test(text) ? "a home usage test survey" : undefined,
    /self[-\s]?assessment/i.test(text) ? "a self-assessment" : undefined,
    /instrumental result|instrumental test/i.test(text) ? "an instrumental test" : undefined,
    /clinical study|clinical test/i.test(text) ? "a clinical study" : undefined,
    /consumer study|independent consumer study|study on \d+/i.test(text) ? "an assessment" : undefined
  ]);
  if (!assessment) {
    return undefined;
  }

  const sample = text.match(/\b(\d+\s+(?:women|men|users|subjects|participants))\b/i)?.[1]?.toLowerCase();
  const duration = first([
    text.match(/\bafter\s+(\d+\s+(?:weeks?|days?|hours?)(?:\s+of\s+(?:daily\s+)?use)?)\b/i)?.[1],
    text.match(/\b(\d+\s+(?:weeks?|days?|hours?))\s+after\s+use\b/i)?.[1]
  ])?.replace("-", " ").toLowerCase();
  const dailyUse = /\bwith daily use\b/i.test(text);
  const durationContext = duration
    ? `after ${dailyUse
      ? duration.replace(/\bof\s+use\b/i, "of daily use").replace(/^(?!.*\bof\s+daily\s+use\b)(.+)$/, "$1 of daily use")
      : /\bof\s+(?:daily\s+)?use\b/i.test(duration) ? duration : `${duration} of use`}`
    : undefined;
  return [
    assessment,
    sample ? `of ${sample}` : undefined,
    durationContext,
    dailyUse && !duration ? "with daily use" : undefined
  ].filter(Boolean).join(" ");
}

function removeEvidenceFootnoteMarkers(value: string): string {
  return value
    .replace(/([A-Za-z])\d+(?=[\s,.;:)]|$)/g, "$1")
    .replace(/\b\d+\s*(?=(?:Home usage|Self-assess|Instrumental|Clinical))/gi, "")
    .replace(/\b\d+\s*$/g, "")
    .trim();
}

function createWebPageFactDescription(locale: PdpGeoLocale, fact: string): string {
  const cleanFact = normalizePublicFactText(truncateAtCompleteSentence(fact, 260));
  return fallback(locale, {
    "ko-KR": `${cleanFact}를 함께 참고할 수 있습니다`,
    "ja-JP": `ページ本文では${cleanFact}も扱います`,
    "en-US": `This product page covers ${formatEnglishFactComplement(cleanFact)}`,
    "en-GB": `This product page covers ${formatEnglishFactComplement(cleanFact)}`
  });
}

function createWebPageUsageDescription(locale: PdpGeoLocale, usage: string): string {
  const normalizedUsage = formatUsageForProductDescription(usage, locale) ?? normalizeUsageInstruction(usage);
  const cleanUsage = trimTrailingSentencePunctuation(truncate(normalizedUsage, 180));
  return fallback(locale, {
    "ko-KR": isKoreanCompleteSentence(cleanUsage) ? `사용법 영역에서는 ${cleanUsage}` : `사용법 영역에서는 ${cleanUsage} 사용법을 다룹니다`,
    "ja-JP": `使い方エリアでは${cleanUsage}のルーティンを扱います`,
    "en-US": `This product page covers routine use, including ${formatEnglishUsagePagePhrase(cleanUsage)}`,
    "en-GB": `This product page covers routine use, including ${formatEnglishUsagePagePhrase(cleanUsage)}`
  });
}

function createKoreanWebPageEvidenceDescription(evidenceSentence: string): string {
  const evidencePhrase = trimTrailingSentencePunctuation(evidenceSentence)
    .replace(/(?:가\s*)?확인됩니다$/u, "")
    .replace(/(?:가\s*)?보고되었습니다$/u, "")
    .replace(/입니다$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return evidencePhrase
    ? createKoreanEvidenceResultSentence(evidencePhrase)
    : "페이지에 공개된 측정/평가 결과를 포함합니다";
}

function createKoreanEvidenceResultSentence(value: string, label = "측정/평가 결과"): string {
  const text = normalizeKoreanEvidenceResultValue(value);
  if (isKoreanNaturalMetricResultSentence(text)) {
    return text;
  }
  if (isKoreanCompleteSentence(text) && !/(?:제시|표기|설명)(?:되어\s*)?있?습니다$/u.test(text)) {
    return text;
  }
  const naturalSentence = formatKoreanEvidenceResultSentence(text);
  if (naturalSentence) {
    return naturalSentence;
  }
  return text ? `${appendKoreanTopicParticle(label)} ${text}입니다` : `${label}를 포함합니다`;
}

function createKoreanDescriptionEvidenceSentence(value: string): string {
  const normalized = normalizeKoreanEvidenceResultValue(value);
  if (isKoreanNaturalMetricResultSentence(normalized)) {
    return ensurePublicSentence(normalized, "ko-KR");
  }
  return ensurePublicSentence(createKoreanEvidenceResultSentence(normalized), "ko-KR");
}

function isKoreanNaturalMetricResultSentence(value: string): boolean {
  return hasQuantifiedReportedSignal(value)
    && new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:했|되었)습니다$`, "u").test(value.trim());
}

function normalizeKoreanEvidenceResultValue(value: string): string {
  return trimTrailingSentencePunctuation(cleanSignal(value)
    .replace(/^(?:측정\/평가\s*결과|측정\s*결과|평가\s*지표|확인\s*지표)(?:는|은|:)?\s*/u, "")
    .replace(/^시험\/평가\s*결과로\s*/u, "")
    .replace(/^(?:평가\s*지표|확인\s*지표)\s*:\s*/u, "")
    .replace(/\s*(?:가\s*)?보고되었습니다$/u, "")
    .replace(/\s*(?:가\s*)?확인됩니다$/u, "")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?(?:으)?로?\\s*(?:제시|표시)(?:됩니다|되었습니다|된다|되며)$`, "u"), "$1")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?\\s*(?:것으로|결과가|수치가)?\\s*제시(?:됩니다|되었습니다|된다|되며)$`, "u"), "$1")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})입니다$`, "u"), "$1")
    .replace(/\s*(?:결과|수치)(?:가|이)?\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim());
}

const KOREAN_METRIC_OUTCOME_PATTERN = "회복|개선|감소|증가|상승|향상|완화|잔존|지속";

function formatKoreanEvidenceResultSentence(value: string): string | undefined {
  const text = normalizeKoreanEvidenceContextPunctuation(value);
  if (!text || !hasQuantifiedReportedSignal(text)) {
    return undefined;
  }

  const { context, claim } = splitKoreanEvidenceContext(text);
  const claimSentence = formatKoreanMetricClaimSentence(claim);
  if (!claimSentence) {
    return undefined;
  }
  return context ? `${context}, ${claimSentence}` : claimSentence;
}

function normalizeKoreanEvidenceContextPunctuation(value: string): string {
  return trimTrailingSentencePunctuation(repairKoreanOcrClauseBoundary(value))
    .replace(/\s*[:：]\s*/g, ": ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * OCR often inserts a sentence stop after a connective that cannot complete a
 * Korean clause (for example "...로 인해. 거칠어진..."). Repair only that
 * grammatical boundary; product names, endpoints and metric values remain
 * evidence-derived.
 */
function repairKoreanOcrClauseBoundary(value: string): string {
  return value.replace(/((?:으?로\s*(?:인해|인한)|에\s*(?:의해|의한)|때문에))\s*[.。]\s*(?=[가-힣A-Za-z0-9])/gu, "$1 ");
}

function splitKoreanEvidenceContext(value: string): { context?: string; claim: string } {
  const text = normalizeKoreanEvidenceContextPunctuation(value);
  const contextMatch = text.match(/^(.{2,140}?)\s*기준\s*(?:평가\s*지표|측정\s*결과)?\s*:?\s*(.+)$/u);
  if (contextMatch?.[1] && contextMatch[2] && !hasQuantifiedReportedSignal(contextMatch[1])) {
    return {
      context: `${normalizeKoreanEvidenceContextPunctuation(contextMatch[1]).replace(/\s*기준$/u, "")} 기준`,
      claim: contextMatch[2].trim()
    };
  }

  const methodMatch = text.match(/^(.{2,140}?(?:테스트|시험|평가|ex\s*vivo|in\s*vitro)[^,，。！？]{0,60}?)(?:에서|으로|에\s*의한)\s+(.+)$/iu);
  if (methodMatch?.[1] && methodMatch[2] && !hasQuantifiedReportedSignal(methodMatch[1])) {
    return {
      context: `${normalizeKoreanEvidenceContextPunctuation(methodMatch[1]).replace(/\s*결과$/u, "")} 기준`,
      claim: methodMatch[2].trim()
    };
  }

  return { claim: text };
}

function formatKoreanMetricClaimSentence(value: string): string | undefined {
  const segments = value
    .split(/\s*;\s*/u)
    .flatMap(splitKoreanCommaSeparatedMetricOutcomeSegments)
    .map((segment) => normalizeKoreanMetricClaimPhrase(segment))
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  const clauses = segments
    .map(formatKoreanMetricClaimSegment)
    .filter((segment): segment is string => Boolean(segment));
  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return clauses[0];
  }

  return clauses
    .map((clause, index) => index < clauses.length - 1 ? convertKoreanResultSentenceToConnector(clause) : clause)
    .join(", ");
}

function splitKoreanCommaSeparatedMetricOutcomeSegments(value: string): string[] {
  const parts = value.split(/\s*,\s*/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [value];
  }
  const outcomePattern = new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:%|배)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?$`, "u");
  return parts.every((part) => outcomePattern.test(part)) ? parts : [value];
}

function normalizeKoreanMetricClaimPhrase(value: string): string {
  return normalizeKoreanEvidenceContextPunctuation(value)
    .replace(/\s*(?:결과|수치)(?:가|이)?\s*$/u, "")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})\\s*\\(\\s*([+\\-−]?\\d+(?:\\.\\d+)?\\s*(?:%|％|배))\\s*\\)$`, "u"), "$2 $1")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?$`, "u"), "$1")
    .trim();
}

function formatKoreanMetricClaimSegment(value: string): string | undefined {
  const text = normalizeKoreanMetricClaimPhrase(value);
  if (!text || !hasQuantifiedReportedSignal(text)) {
    return undefined;
  }

  const durationBeforeSubject = text.match(/^(.{0,100}?)(\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월))\s*(?:동안\s*)?(.{1,50}?(?:보습|수분))\s*지속$/u);
  if (durationBeforeSubject?.[2] && durationBeforeSubject[3]) {
    const context = cleanSignal(durationBeforeSubject[1] ?? "");
    const subject = durationBeforeSubject[3].trim();
    return `${context ? `${context} ` : ""}${appendKoreanSubjectParticle(subject)} ${durationBeforeSubject[2].trim()} 지속됩니다`;
  }

  const subjectBeforeDuration = text.match(/^(.{0,100}?)(.{1,50}?(?:보습|수분))(?:은|는|이|가)?\s*(\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월))\s*(?:동안\s*)?지속$/u);
  if (subjectBeforeDuration?.[2] && subjectBeforeDuration[3]) {
    const context = cleanSignal(subjectBeforeDuration[1] ?? "");
    const subject = subjectBeforeDuration[2].trim();
    return `${context ? `${context} ` : ""}${appendKoreanSubjectParticle(subject)} ${subjectBeforeDuration[3].trim()} 지속됩니다`;
  }

  const signedMetric = "[+\\-−]?\\d+(?:\\.\\d+)?\\s*(?:%|배)";
  const dualOutcomeBeforeMetric = text.match(new RegExp(`^(.{0,48}?)(.{2,90}?)\\s+(${KOREAN_METRIC_OUTCOME_PATTERN})\\s+(${signedMetric})\\s*(?:및|과|와|,)\\s*(.{2,90}?)\\s+(${KOREAN_METRIC_OUTCOME_PATTERN})\\s+(${signedMetric})$`, "u"));
  if (dualOutcomeBeforeMetric?.[2] && dualOutcomeBeforeMetric[3] && dualOutcomeBeforeMetric[4] && dualOutcomeBeforeMetric[5] && dualOutcomeBeforeMetric[6] && dualOutcomeBeforeMetric[7]) {
    const prefix = cleanSignal(dualOutcomeBeforeMetric[1] ?? "");
    const firstSubject = formatKoreanMetricSubject(`${prefix} ${dualOutcomeBeforeMetric[2]}`.trim());
    const secondSubject = formatKoreanMetricSubject(dualOutcomeBeforeMetric[5]);
    const firstClause = `${firstSubject} ${dualOutcomeBeforeMetric[4].trim()} ${koreanMetricOutcomePredicate(dualOutcomeBeforeMetric[3].trim())}`;
    const secondClause = `${secondSubject} ${dualOutcomeBeforeMetric[7].trim()} ${koreanMetricOutcomePredicate(dualOutcomeBeforeMetric[6].trim())}`;
    return `${convertKoreanResultSentenceToConnector(firstClause)}, ${secondClause}`;
  }

  const retainedAndImproved = text.match(/^(.{2,120}?)\s+잔존\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*,\s*(.{2,90}?)\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*(?:및|과|와)\s*(.{2,90}?)\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*개선$/u);
  if (retainedAndImproved?.[1] && retainedAndImproved[2] && retainedAndImproved[3] && retainedAndImproved[4] && retainedAndImproved[5] && retainedAndImproved[6]) {
    return `${formatKoreanMetricSubject(`${retainedAndImproved[1]} 잔존율`)} ${retainedAndImproved[2].trim()}이고, ${formatKoreanMetricSubject(retainedAndImproved[3])} ${retainedAndImproved[4].trim()}, ${formatKoreanMetricSubject(retainedAndImproved[5])} ${retainedAndImproved[6].trim()} 개선되었습니다`;
  }

  const particleSubject = text.match(new RegExp(`^(.{2,120}?(?:은|는))\\s+(.{1,180}?\\d+(?:\\.\\d+)?\\s*(?:%|배).{0,120}?)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (particleSubject?.[1] && particleSubject[2] && particleSubject[3]) {
    return `${particleSubject[1].trim()} ${particleSubject[2].trim()} ${koreanMetricOutcomePredicate(particleSubject[3])}`;
  }

  const dualMetric = text.match(new RegExp(`^(.{2,90}?)\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(?:및|과|와|,)\\s*(.{2,90}?)\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (dualMetric?.[1] && dualMetric[2] && dualMetric[3] && dualMetric[4] && dualMetric[5]) {
    const firstSubject = formatKoreanMetricSubject(dualMetric[1]);
    const secondSubject = formatKoreanMetricSubject(dualMetric[3]);
    return `${firstSubject} ${dualMetric[2].trim()}, ${secondSubject} ${dualMetric[4].trim()} ${koreanMetricOutcomePredicate(dualMetric[5])}`;
  }

  const metricBeforeOutcome = text.match(new RegExp(`^(.{0,140}?)\\s*(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (metricBeforeOutcome?.[2] && metricBeforeOutcome[3]) {
    const subject = normalizeKoreanMetricClaimPhrase(metricBeforeOutcome[1] ?? "");
    const metric = metricBeforeOutcome[2].trim();
    const outcome = metricBeforeOutcome[3].trim();
    return subject
      ? `${formatKoreanMetricSubject(subject)} ${metric} ${koreanMetricOutcomePredicate(outcome)}`
      : `${metric} ${koreanMetricOutcomePredicate(outcome)}`;
  }

  const outcomeBeforeMetric = text.match(new RegExp(`^(.{2,120}?)\\s+(${KOREAN_METRIC_OUTCOME_PATTERN})\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))$`, "u"));
  if (outcomeBeforeMetric?.[1] && outcomeBeforeMetric[2] && outcomeBeforeMetric[3]) {
    const subject = normalizeKoreanMetricClaimPhrase(outcomeBeforeMetric[1]);
    const outcome = outcomeBeforeMetric[2].trim();
    const metric = outcomeBeforeMetric[3].trim();
    if (outcome === "잔존") {
      return `${formatKoreanMetricSubject(`${subject} 잔존율`)} ${metric}입니다`;
    }
    return `${formatKoreanMetricSubject(subject)} ${metric} ${koreanMetricOutcomePredicate(outcome)}`;
  }

  const trailingOutcome = text.match(new RegExp(`^(.{2,220}?\\d+(?:\\.\\d+)?\\s*(?:%|배).{0,120}?)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (trailingOutcome?.[1] && trailingOutcome[2]) {
    return `${trailingOutcome[1].trim()} ${koreanMetricOutcomePredicate(trailingOutcome[2])}`;
  }

  return undefined;
}

function formatKoreanMetricSubject(value: string): string {
  const subject = normalizeKoreanMetricClaimPhrase(value)
    .replace(/\s*(?:은|는)$/u, "")
    .trim();
  if (isKoreanMetricTimingOnlySubject(subject)) {
    return subject;
  }
  return subject ? appendKoreanTopicParticle(subject) : subject;
}

function isKoreanMetricTimingOnlySubject(value: string): boolean {
  return /^(?:사용|도포|적용|세정)\s*(?:직후|전|후|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후)$/u.test(value)
    || /^\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*(?:후|동안|뒤)$/u.test(value);
}

function koreanMetricOutcomePredicate(outcome: string): string {
  switch (outcome.trim()) {
    case "증가":
      return "증가했습니다";
    case "감소":
      return "감소했습니다";
    case "상승":
      return "상승했습니다";
    case "잔존":
      return "잔존했습니다";
    case "지속":
      return "지속되었습니다";
    case "회복":
      return "회복되었습니다";
    case "개선":
      return "개선되었습니다";
    case "향상":
      return "향상되었습니다";
    case "완화":
      return "완화되었습니다";
    default:
      return `${outcome.trim()}되었습니다`;
  }
}

function convertKoreanResultSentenceToConnector(value: string): string {
  return value
    .replace(/되었습니다$/u, "되었고")
    .replace(/했습니다$/u, "했고")
    .replace(/입니다$/u, "이고");
}

function createJapaneseWebPageEvidenceDescription(evidenceSentence: string): string {
  const evidencePhrase = trimTrailingSentencePunctuation(evidenceSentence)
    .replace(/(?:確認\s*指標|確認\s*根拠|測定\s*結果|評価\s*指標)\s*:\s*/gi, " ")
    .replace(/(?:を)?確認できます$/u, "")
    .replace(/(?:を)?参照できます$/u, "")
    .replace(/です$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return evidencePhrase
    ? `測定/評価情報では${evidencePhrase}を扱います`
    : "測定/評価情報ではページ上の公開結果を扱います";
}

function createKoreanIngredientDetailDescription(ingredientPhrase: string, ingredientDetail: string): string {
  const cleanDetail = trimTrailingSentencePunctuation(ingredientDetail);
  return isKoreanCompleteSentence(cleanDetail)
    ? `주요 성분/기술은 ${ingredientPhrase}이며, 성분 설명에서는 ${cleanDetail}`
    : `주요 성분/기술은 ${ingredientPhrase}이며, 성분 설명은 ${cleanDetail}에 초점을 둡니다`;
}

function createLocalizedUsageComparisonDescription(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  context: DescriptionContext
): string | undefined {
  switch (locale) {
    case "ko-KR": {
      const usage = createKoreanHighLevelUsageContext(product, context);
      const comparison = createKoreanProductComparisonContext(product);
      if (usage && comparison) {
        return `${usage} 루틴에 어울리고, ${comparison} 맥락에서도 선택 기준이 분명합니다`;
      }
      if (usage) {
        return `${usage} 루틴에 어울립니다`;
      }
      return comparison ? `${comparison} 맥락에서 선택 기준이 분명합니다` : undefined;
    }
    case "ja-JP": {
      const usage = createJapaneseHighLevelUsageContext(product);
      const comparison = createJapaneseProductComparisonContext(product);
      if (usage && comparison) {
        return `${usage}のルーティンに取り入れやすく、${comparison}の文脈でも選びやすい商品です`;
      }
      if (usage) {
        return `${usage}のルーティンに取り入れやすい商品です`;
      }
      return comparison ? `${comparison}の文脈で選びやすい商品です` : undefined;
    }
    case "en-GB":
    case "en-US":
    default: {
      const usage = createEnglishHighLevelUsageContext(product);
      const comparison = createEnglishProductComparisonContext(product);
      if (usage && comparison) {
        return `It also fits ${usage}, with ${comparison} as a product-choice context`;
      }
      if (usage) {
        return `It also fits ${usage}`;
      }
      return comparison ? `It can be compared through ${comparison}` : undefined;
    }
  }
}

function createKoreanHighLevelUsageContext(product: PdpProductSignal, _context: DescriptionContext): string | undefined {
  const text = allProductEvidenceText(product);
  if (/건조[^.!?。！？\n]{0,24}(?:때마다|할\s*때|느껴질\s*때|부위|순간|수시)|수시(?:로)?\s*(?:보습|사용|분사|뿌리)/u.test(text)) {
    return "건조할 때 수시 보습";
  }
  if (/(?:세안\s*(?:후|직후)|첫\s*단계)[^.!?。！？\n]{0,40}(?:보습|수분|토너|스킨케어|루틴)/u.test(text)) {
    return "세안 후 첫 단계 보습";
  }
  if (/(?:아침|저녁|밤|나이트)[^.!?。！？\n]{0,40}(?:크림|스킨케어|루틴|단계)|(?:크림|스킨케어)\s*단계/u.test(text)) {
    return "아침·저녁 스킨케어";
  }
  if (/(?:메이크업|화장)[^.!?。！？\n]{0,24}(?:전|전에|잘\s*먹|밀착)/u.test(text)) {
    return "메이크업 전 보습";
  }
  if (/(?:토너|스킨)[^.!?。！？\n]{0,24}(?:다음|후|이후)|(?:세럼|에센스)\s*단계/u.test(text)) {
    return "토너 다음 스킨케어";
  }
  if (/(?:데일리|매일|매일같이|everyday|daily)/i.test(text)) {
    return "데일리 케어";
  }
  return undefined;
}

function createKoreanProductComparisonContext(product: PdpProductSignal): string | undefined {
  const text = allProductEvidenceText(product);
  if (/일반\s*미스트[^.!?。！？\n]{0,80}크림\s*미스트|크림\s*미스트[^.!?。！？\n]{0,80}일반\s*미스트/u.test(text)) {
    return "일반 미스트와 크림 미스트 비교";
  }
  if (/(?:크림|세럼|로션|토너|에센스)\s*(?:리치|소프트|클래식|EX|엑스|리뉴얼|대체|버전)|(?:리치|소프트|클래식|EX|엑스)\s*(?:제형|버전|타입)/iu.test(text)) {
    return "제형·버전 비교";
  }
  return undefined;
}

function createJapaneseHighLevelUsageContext(product: PdpProductSignal): string | undefined {
  const text = allProductEvidenceText(product);
  if (/乾燥|随時|いつでも|必要なとき/u.test(text)) {
    return "乾燥が気になるときの保湿";
  }
  if (/洗顔後|最初のステップ|ファーストステップ/u.test(text)) {
    return "洗顔後のファーストステップ保湿";
  }
  if (/朝|夜|クリーム\s*ステップ|スキンケア/u.test(text)) {
    return "朝晩のスキンケア";
  }
  if (/メイク前|化粧前/u.test(text)) {
    return "メイク前の保湿";
  }
  if (/デイリー|毎日/u.test(text)) {
    return "デイリーケア";
  }
  return undefined;
}

function createJapaneseProductComparisonContext(product: PdpProductSignal): string | undefined {
  const text = allProductEvidenceText(product);
  if (/通常のミスト[^。！？]{0,80}クリームミスト|クリームミスト[^。！？]{0,80}通常のミスト/u.test(text)) {
    return "通常のミストとの比較";
  }
  if (/(?:リッチ|ソフト|クラシック|EX|リニューアル|代替|バージョン|タイプ)[^。！？]{0,60}(?:比較|違い|選択)|(?:比較|違い)[^。！？]{0,60}(?:リッチ|ソフト|クラシック|EX|バージョン|タイプ)/iu.test(text)) {
    return "テクスチャーやバージョン比較";
  }
  return undefined;
}

function createEnglishHighLevelUsageContext(product: PdpProductSignal): string | undefined {
  const text = allProductEvidenceText(product);
  const usageText = [...product.usage, ...(product.semanticFacts?.usageSteps ?? [])].join(" ");
  if (/dry(?:ness)?[^.!?\n]{0,40}(?:as needed|whenever|anytime|throughout the day)|as-needed hydration|throughout the day/i.test(text)) {
    return "as-needed hydration for dry moments";
  }
  if (/(?:morning|evening|night)[^.!?\n]{0,60}(?:after\s+(?:applying\s+)?toner|toner step|serum step)|(?:after\s+(?:applying\s+)?toner|toner step|serum step)[^.!?\n]{0,60}(?:morning|evening|night)/i.test(usageText)) {
    return "a morning and evening post-toner routine";
  }
  if (/(?:after\s+(?:applying\s+)?toner|toner step|serum step)/i.test(usageText)) {
    return "the post-toner serum step";
  }
  if (/post[-\s]?cleanse|after cleansing|first step/i.test(usageText)) {
    return "post-cleanse first-step hydration";
  }
  if (/(?:morning|evening|night)[^.!?\n]{0,40}(?:cream|skin-care|skincare|routine|step)|cream step/i.test(usageText)) {
    return "a morning and evening skin-care routine";
  }
  if (/pre[-\s]?makeup|before makeup/i.test(text)) {
    return "pre-makeup moisturising";
  }
  if (/daily|everyday/i.test(text)) {
    return "daily care";
  }
  return undefined;
}

function createEnglishProductComparisonContext(product: PdpProductSignal): string | undefined {
  const text = allProductEvidenceText(product);
  if (/regular mist[^.!?\n]{0,80}cream mist|cream mist[^.!?\n]{0,80}regular mist/i.test(text)) {
    return "regular mist versus cream mist comparison";
  }
  if (/(?:rich|soft|classic|renewal|replacement|version|variant)\b[^.!?\n]{0,80}\b(?:compare|comparison|difference|differs|choose|choice|versus|vs\.?)\b|\b(?:compare|comparison|difference|differs|choose|choice|versus|vs\.?)\b[^.!?\n]{0,80}(?:rich|soft|classic|renewal|replacement|version|variant)\b/i.test(text)) {
    return "texture or version comparison";
  }
  return undefined;
}

function createLocalizedReviewDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (locale === "ko-KR") {
    return createKoreanReviewSummaryDescription(context);
  }
  if (context.representativeReviewPhrase) {
    switch (locale) {
      case "ja-JP":
        return `代表的なレビューでは${context.representativeReviewPhrase}のように語られ${context.reviewPhrase ? `、${context.reviewPhrase}などの反復表現も確認できます` : ""}`;
      case "en-GB":
      case "en-US":
      default:
        return `Representative customer reviews ${formatEnglishRepresentativeReviewClause(context.representativeReviewPhrase)}${context.reviewPhrase ? `, with repeated review language such as ${context.reviewPhrase}` : ""}`;
    }
  }

  if (!context.reviewPhrase) {
    return undefined;
  }

  return fallback(locale, {
    "ko-KR": `고객 리뷰에서는 ${context.reviewPhrase} 관련 경험이 반복해서 언급됩니다`,
    "ja-JP": `レビューでは${context.reviewPhrase}などの表現が見られ、使用感と期待できるケア文脈を補足します`,
    "en-US": `Customer reviews mention ${context.reviewPhrase}, which supports the product's texture, moisture, firmness, and visible skin-care context`,
    "en-GB": `Customer reviews mention ${context.reviewPhrase}, which supports the product's texture, moisture, firmness, and visible skin-care context`
  });
}

function formatEnglishRepresentativeReviewClause(value: string): string {
  const phrase = trimTrailingSentencePunctuation(cleanSignal(value));
  if (/^(?:feels?|absorbs?|applies|blends|leaves|keeps|provides|works|wears|looks|smells|has|is|was)\b/i.test(phrase)) {
    return `report that it ${lowercaseFirst(phrase)}`;
  }
  if (/^(?:it|this|the product)\b/i.test(phrase)) {
    return `report that ${lowercaseFirst(phrase)}`;
  }
  return `highlight ${phrase}`;
}

function createKoreanReviewSummaryDescription(context: DescriptionContext): string | undefined {
  const reviewTerms = dedupePublicListValues([
    ...context.reviewKeywords,
    ...context.reviewBodies.flatMap(extractKoreanReviewSummarySignals),
    ...context.representativeReviews.flatMap((value) => [
      ...value.split(/\s*,\s*/u),
      ...extractKoreanReviewSummarySignals(value)
    ])
  ]
    .map(normalizeKoreanReviewSummaryTerm)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNegativeReviewSignalText(value)))
    .map((value, index) => ({ value, index, score: koreanReviewSummaryPriority(value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.value)
    .slice(0, 4);
  const reviewPhrase = formatKoreanReviewSummaryPhrase(reviewTerms);
  return reviewPhrase
    ? `고객 리뷰에서는 ${appendKoreanSubjectParticle(reviewPhrase)} 반복해서 언급됩니다`
    : undefined;
}

function extractKoreanReviewSummarySignals(value: string): string[] {
  const text = cleanSignal(value);
  return unique([
    /촉촉|보습력|보습감|수분감/u.test(text) ? "촉촉한 사용감" : "",
    /자극\s*(?:없|없이|적)/u.test(text) ? "자극 없이 편안한 사용감" : "",
    !/자극\s*(?:없|없이|적)/u.test(text) && /순한|편안/u.test(text) ? "순한 사용감" : "",
    /끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않|산뜻|가벼운/u.test(text) ? "끈적임이 적은 마무리" : "",
    /(?:피부결[^.。！？]{0,24}(?:매끄|부드러)|(?:매끄|부드러)[^.。！？]{0,24}피부결)/u.test(text) ? "매끄러운 피부결" : "",
    /만족/u.test(text) ? "만족도" : ""
  ].filter(Boolean));
}

function formatKoreanReviewSummaryPhrase(values: string[]): string | undefined {
  const terms = [...values];
  const moistureIndex = terms.findIndex((value) => value === "촉촉한 사용감");
  const gentleIndex = terms.findIndex((value) => value === "자극 없이 편안한 사용감" || value === "순한 사용감");
  if (moistureIndex > -1 && gentleIndex > -1) {
    const combined = terms[gentleIndex] === "자극 없이 편안한 사용감"
      ? "촉촉하고 자극 없이 편안한 사용감"
      : "촉촉하고 편안한 사용감";
    terms.splice(Math.max(moistureIndex, gentleIndex), 1);
    terms.splice(Math.min(moistureIndex, gentleIndex), 1, combined);
  }
  return formatKoreanNaturalList(terms);
}

function koreanReviewSummaryPriority(value: string): number {
  if (/(?:촉촉|보습|수분)/u.test(value)) return 4;
  if (/(?:자극\s*없이|순한|편안)/u.test(value)) return 3.5;
  if (/(?:끈적임이\s*적|산뜻|가벼운)/u.test(value)) return 3;
  if (/(?:피부결|매끄|탄력|광채)/u.test(value)) return 2.5;
  if (/(?:만족|사계절|장벽)/u.test(value)) return 2;
  return 1;
}

function normalizeKoreanReviewSummaryTerm(value: string): string | undefined {
  const text = trimTrailingSentencePunctuation(cleanSignal(value));
  if (!text || text.length > 50) {
    return undefined;
  }
  if (/자극\s*(?:없|없이|적)/u.test(text)) {
    return "자극 없이 편안한 사용감";
  }
  if (/끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않/u.test(text)) {
    return "끈적임이 적은 마무리";
  }
  if (/촉촉|보습력|보습감|수분감/u.test(text)) {
    return "촉촉한 사용감";
  }
  if (/순한|편안/u.test(text)) {
    return "순한 사용감";
  }
  if (/재구매/u.test(text)) {
    return "재구매 의향";
  }
  if (/(?:피부\s*)?장벽[^.。！？]{0,20}(?:개선|강화|보습)|(?:개선|강화|보습)[^.。！？]{0,20}(?:피부\s*)?장벽/u.test(text)) {
    return "피부 장벽 케어에 대한 긍정 평가";
  }
  if (/^피부결$/u.test(text)) {
    return undefined;
  }
  if (/(?:제품|상품|고객|가족|구매|사용|발랐|써보|좋(?:아|았|습|네|더)|만족(?:했|합)|합니다|됩니다|입니다|해요|했어요|네요|니다)/u.test(text)) {
    return undefined;
  }
  return text.length <= 24 ? text : undefined;
}

function formatDescriptionList(values: string[], locale: PdpGeoLocale, limit: number): string | undefined {
  const items = unique(values.map(cleanSignal).filter(Boolean)).slice(0, limit);
  if (items.length === 0) {
    return undefined;
  }
  if (items.length === 1) {
    return items[0];
  }
  if (locale === "ko-KR") {
    return items.join(", ");
  }
  if (locale === "ja-JP") {
    return items.join("、");
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function lowercaseEnglishProductType(productType: string): string {
  return productType.replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());
}

function englishProductTypeWithArticle(productType: string): string {
  const normalized = lowercaseEnglishProductType(productType);
  const article = /^[aeiou]/i.test(normalized) ? "an" : "a";
  return `${article} ${normalized}`;
}

function localizeProductTypeForLocale(productType: string, locale: PdpGeoLocale): string {
  const normalized = cleanSignal(productType);
  const lower = normalized.toLowerCase();
  const productTypeMap: Record<PdpGeoLocale, Array<[RegExp, string]>> = {
    "ko-KR": [
      [/body\s*lotion|바디\s*로션|바디로션/i, "바디로션"],
      [/cream\s*mist|크림\s*미스트|크림미스트/i, "크림 미스트"],
      [/\bmist\b|미스트/i, "미스트"],
      [/lotion|로션/i, "로션"],
      [/cream|크림/i, "크림"],
      [/serum|세럼|앰플|에센스/i, "세럼"],
      [/toner|토너|스킨/i, "토너"],
      [/cleanser|클렌저|폼/i, "클렌저"],
      [/mask|마스크/i, "마스크"]
    ],
    "ja-JP": [
      [/body\s*lotion|ボディローション/i, "ボディローション"],
      [/cream\s*mist|クリーム\s*ミスト/i, "クリームミスト"],
      [/mist|ミスト/i, "ミスト"],
      [/lotion|ローション/i, "ローション"],
      [/cream|クリーム/i, "クリーム"],
      [/serum|美容液|セラム/i, "美容液"],
      [/toner|化粧水/i, "化粧水"],
      [/cleanser|洗顔|クレンザー/i, "クレンザー"],
      [/mask|マスク/i, "マスク"]
    ],
    "en-US": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
      [/cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト/i, "Cream Mist"],
      [/\bmist\b|미스트|ミスト/i, "Mist"],
      [/lotion|로션|ローション/i, "Lotion"],
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ],
    "en-GB": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
      [/cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト/i, "Cream Mist"],
      [/\bmist\b|미스트|ミスト/i, "Mist"],
      [/lotion|로션|ローション/i, "Lotion"],
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ]
  };

  for (const [pattern, localized] of productTypeMap[locale]) {
    if (pattern.test(lower)) {
      return localized;
    }
  }

  return normalized;
}

function inferTargetCustomer(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const recommendedSkinType = inferRecommendedSkinType(product, locale);

  if (recommendedSkinType) {
    const broadSkinTypeScope = /^(?:all|most)\s+skin\s+types$/i.test(recommendedSkinType)
      || /^(?:모든|대부분의)\s*피부\s*타입$/u.test(recommendedSkinType)
      || /^(?:すべて|ほとんど)の肌タイプ$/u.test(recommendedSkinType);
    return fallback(locale, {
      "ko-KR": `${recommendedSkinType} 고객`,
      "ja-JP": `${recommendedSkinType}のお客様`,
      "en-US": broadSkinTypeScope ? `customers across ${recommendedSkinType}` : `customers with ${recommendedSkinType}`,
      "en-GB": broadSkinTypeScope ? `customers across ${recommendedSkinType}` : `customers with ${recommendedSkinType}`
    });
  }

  return fallback(locale, {
    "ko-KR": "고객",
    "ja-JP": "お客様",
    "en-US": "customers",
    "en-GB": "customers"
  });
}

function isSpecificTargetCustomer(value: string | undefined, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return false;
  }
  const genericTargets: Record<PdpGeoLocale, RegExp> = {
    "ko-KR": /^(?:고객|상품의\s*핵심\s*효능|사용법을\s*빠르게\s*확인)$/,
    "ja-JP": /^(?:お客様|商品の主な特徴)$/,
    "en-US": /^(?:customers|key benefits and routine fit|product's key benefits)$/i,
    "en-GB": /^(?:customers|key benefits and routine fit|product's key benefits)$/i
  };
  return !genericTargets[locale].test(text);
}

function extractTargetAudienceAgeSample(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value);
  const koreanAgeRange = text.match(/(?:만\s*)?(\d{2})\s*[~\-–—]\s*(\d{2})\s*세(?:의)?\s*(?:성인\s*)?(여성|남성|남녀|사용자|참여자|대상자|고객)?(?:\s*\d+\s*명)?/);
  if (koreanAgeRange?.[1] && koreanAgeRange[2]) {
    const range = `${koreanAgeRange[1]}~${koreanAgeRange[2]}세`;
    const audience = normalizeKoreanAudienceLabel(koreanAgeRange[3]);
    if (locale === "ko-KR") {
      return `${range} ${audience} 고객`;
    }
    if (locale === "ja-JP") {
      return `${range}の${audience === "여성" ? "女性" : audience === "남성" ? "男性" : "対象者"}`;
    }
    return `${audience === "여성" ? "women" : audience === "남성" ? "men" : "participants"} aged ${koreanAgeRange[1]}-${koreanAgeRange[2]}`;
  }

  const englishAgeRange = text.match(/\b(?:women|men|participants|subjects|users)?\s*(?:aged|ages?)\s*(\d{2})\s*(?:to|[-–—])\s*(\d{2})\b|\b(\d{2})\s*(?:to|[-–—])\s*(\d{2})\s*(?:year[-\s]?old|yo)\s*(women|men|participants|subjects|users)?\b/i);
  const start = englishAgeRange?.[1] ?? englishAgeRange?.[3];
  const end = englishAgeRange?.[2] ?? englishAgeRange?.[4];
  const audience = normalizeEnglishAudienceLabel(englishAgeRange?.[0] ?? englishAgeRange?.[5]);
  if (!start || !end) {
    return undefined;
  }
  if (locale === "ko-KR") {
    return `${start}~${end}세 ${audience === "women" ? "여성" : audience === "men" ? "남성" : "대상자"} 고객`;
  }
  if (locale === "ja-JP") {
    return `${start}~${end}歳の${audience === "women" ? "女性" : audience === "men" ? "男性" : "対象者"}`;
  }
  return `${audience} aged ${start}-${end}`;
}

function normalizeKoreanAudienceLabel(value: string | undefined): string {
  if (/남성/.test(value ?? "")) {
    return "남성";
  }
  if (/남녀|사용자|참여자|대상자|고객/.test(value ?? "")) {
    return "대상자";
  }
  return "여성";
}

function normalizeEnglishAudienceLabel(value: string | undefined): "women" | "men" | "participants" {
  const text = value ?? "";
  if (/men\b/i.test(text) && !/women/i.test(text)) {
    return "men";
  }
  if (/women/i.test(text)) {
    return "women";
  }
  return "participants";
}

function inferRecommendedSkinType(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const explicitSuitability = selectExplicitSuitabilitySkinTypes(product, locale);
  if (explicitSuitability) {
    return explicitSuitability;
  }
  const semanticSkinType = formatRecommendedSkinTypeList(product.semanticFacts?.skinTypes ?? [], locale, 3);
  if (semanticSkinType) {
    return semanticSkinType;
  }
  return undefined;
}

function selectExplicitSuitabilitySkinTypes(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const candidates = [
    product.description,
    ...product.faq.flatMap((item) => [item.answer, item.question]),
    ...product.benefits,
    ...product.effects,
    ...product.sourceTexts.filter((value) => /(?:suitable\s+for|recommended\s+for|ideal\s+for|designed\s+for|formulated\s+for|developed\s+for|speciali[sz]ed\s+for|적합|추천|위한|특화|맞춤)/iu.test(value))
  ].filter((value): value is string => Boolean(value));
  const collectedTypes: string[] = [];
  for (const candidate of candidates) {
    const positiveClause = cleanSignal(candidate).split(/(?:patch\s*test|patch\s*testing|주의|다만|however|but\s+those\s+with)/i)[0] ?? "";
    if (!/(?:suitable\s+for|recommended\s+for|ideal\s+for|designed\s+for|formulated\s+for|developed\s+for|speciali[sz]ed\s+for|for\s+(?:all|most)\s+skin\s+types|\bfor\s+(?:(?:sensitive|dry|oily|combination|normal|mature)(?:\s+(?:and|or)\s+)?)+skin\b|적합|추천|위한|특화|맞춤)/i.test(positiveClause)) {
      continue;
    }
    if (/\bmost\s+skin\s+types\b/i.test(positiveClause) || /대부분의?\s*피부\s*타입/u.test(positiveClause)) {
      return locale === "ko-KR" ? "대부분의 피부 타입" : locale === "ja-JP" ? "ほとんどの肌タイプ" : "most skin types";
    }
    if (/\ball\s+skin\s+types\b/i.test(positiveClause)) {
      return locale === "ko-KR" ? "모든 피부 타입" : locale === "ja-JP" ? "すべての肌タイプ" : "all skin types";
    }
    const types = unique([
      ...Array.from(positiveClause.matchAll(/\b(sensitive|dry|oily|combination|normal|mature)\s+(?:and|or)\s+(sensitive|dry|oily|combination|normal|mature)\s+skin\b/gi))
        .flatMap((match) => [`${match[1]} skin`, `${match[2]} skin`]),
      ...Array.from(positiveClause.matchAll(/\b(sensitive|dry|oily|combination|normal|mature)\s+skin\b/gi)).map((match) => `${match[1]} skin`),
      ...Array.from(positiveClause.matchAll(/(민감|건조|건성|지성|복합성?|중성)\s*(?:하고|하거나|및|또는|과|와|\/)\s*(민감|건조|건성|지성|복합성?|중성)\s*(?:한\s*)?피부/gu))
        .flatMap((match) => [`${match[1]} 피부`, `${match[2]} 피부`]),
      ...Array.from(positiveClause.matchAll(/(민감|건조|건성|지성|복합성?|중성)\s*(?:한\s*)?피부/gu)).map((match) => `${match[1]} 피부`)
    ]);
    collectedTypes.push(...types);
  }
  return formatRecommendedSkinTypeList(unique(collectedTypes), locale, 3);
}

function formatRecommendedSkinTypeList(values: string[], locale: PdpGeoLocale, limit: number): string | undefined {
  const localized = unique(values
    .flatMap((value) => cleanSignal(value).split(/\s*(?:,|，|\/|·|또는|및|または|および)\s*|\s+(?:or|and)\s+/iu))
    .map((value) => localizeSkinTypeSignal(value, locale))
    .filter((value): value is string => Boolean(value)))
    .slice(0, limit);
  if (localized.length === 0) {
    return undefined;
  }
  if (localized.length === 1) {
    return localized[0];
  }
  if (locale === "ko-KR") {
    return localized.join(" 또는 ");
  }
  if (locale === "ja-JP") {
    return localized.join("または");
  }
  return localized.length === 2
    ? `${localized[0]} or ${localized[1]}`
    : `${localized.slice(0, -1).join(", ")}, or ${localized.at(-1)}`;
}

function localizeSkinTypeSignal(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value);
  if (!text) {
    return undefined;
  }
  const type = /(?:민감\s*피부|민감성|sensitive\s*skin|敏感肌)/i.test(text)
    ? "sensitive"
    : /(?:건조\s*피부|건성|dry\s*skin|乾燥肌)/i.test(text)
      ? "dry"
      : /(?:지성\s*피부|oily\s*skin|脂性肌)/i.test(text)
        ? "oily"
        : /(?:복합성?\s*피부|combination\s*skin|混合肌)/i.test(text)
          ? "combination"
          : /(?:중성\s*피부|normal\s*skin|普通肌)/i.test(text)
            ? "normal"
            : undefined;
  if (!type) {
    const localeCompatible = locale === "ko-KR"
      ? /[가-힣]/u.test(text) && !/[A-Za-z]{3,}/u.test(text)
      : locale === "ja-JP"
        ? /[ぁ-んァ-ン一-龥]/u.test(text) && !/[가-힣]/u.test(text)
        : !/[가-힣ぁ-んァ-ン]/u.test(text);
    return localeCompatible ? normalizeInferencePublicText(text, locale) : undefined;
  }
  const labels: Record<typeof type, Record<PdpGeoLocale, string>> = {
    sensitive: { "ko-KR": "민감 피부", "ja-JP": "敏感肌", "en-US": "sensitive skin", "en-GB": "sensitive skin" },
    dry: { "ko-KR": "건조 피부", "ja-JP": "乾燥肌", "en-US": "dry skin", "en-GB": "dry skin" },
    oily: { "ko-KR": "지성 피부", "ja-JP": "脂性肌", "en-US": "oily skin", "en-GB": "oily skin" },
    combination: { "ko-KR": "복합성 피부", "ja-JP": "混合肌", "en-US": "combination skin", "en-GB": "combination skin" },
    normal: { "ko-KR": "중성 피부", "ja-JP": "普通肌", "en-US": "normal skin", "en-GB": "normal skin" }
  };
  return labels[type][locale];
}

function normalizeKoreanSkinTypeList(value: string): string | undefined {
  const items = unique(value
    .replace(/\s+/g, " ")
    .split(/\s*(?:또는|및|,|\/|·)\s*/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (/건조|건성/.test(item)) {
        return "건조 피부";
      }
      if (/민감/.test(item)) {
        return "민감 피부";
      }
      if (/지성/.test(item)) {
        return "지성 피부";
      }
      if (/복합/.test(item)) {
        return "복합성 피부";
      }
      return item.endsWith("피부") ? item : `${item} 피부`;
    }));
  return formatDescriptionList(items, "ko-KR", 3)?.replace(/,\s*/g, " 또는 ");
}

function selectPublicPrimaryBenefit(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[] = []): string | undefined {
  return first(selectPublicBenefitSignals(product, locale, localizedTerms));
}

function selectPublicBenefitSignals(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[] = []): string[] {
  return dedupePublicListValues([
    ...selectBenefitSignals(product),
    ...localizedTerms.filter(isUsefulBenefitSignal)
  ]
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isIngredientRoleCollision(value, product))
    .filter((value) => !isProductEntityOnlySignal(value, product))
    .filter((value) => !isLowQualityBenefitSignal(value))
    .filter((value) => isBenefitCompatibleWithProduct(value, product))
    .filter(isUsefulPublicListValue))
    .slice(0, 10);
}

function selectClaimedBenefitSignals(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  const primarySources = [
    ...(product.semanticFacts?.benefits ?? []),
    ...product.benefits,
    ...(product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [link.benefit, link.effect].filter((value): value is string => Boolean(value)))
  ];
  const fallbackSources = [
    ...(product.semanticFacts?.effects ?? []),
    ...product.effects
  ];
  const normalize = (values: string[]) => dedupePublicListValues(values
    .filter((value) => !isIngredientRoleCollision(value, product))
    .flatMap(extractBenefitSignalCandidates)
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => isBenefitCompatibleWithProduct(value, product))
    .filter(isUsefulPublicListValue));
  const primary = removeBenefitSubsetRedundancy(normalize(primarySources));
  return (primary.length > 0 ? primary : removeBenefitSubsetRedundancy(normalize(fallbackSources))).slice(0, 8);
}

function isIngredientRoleCollision(value: string, product: PdpProductSignal): boolean {
  const candidate = signalEntityKey(value);
  if (!candidate) {
    return false;
  }
  const collides = [
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? [])
  ].some((ingredient) => signalEntityKey(ingredient) === candidate);
  if (!collides) {
    return false;
  }
  return !(product.semanticFacts?.ingredientBenefitLinks ?? []).some((link) => {
    const outcome = cleanSignal(link.benefit ?? link.effect ?? "");
    return outcome && signalEntityKey(outcome) === candidate && cleanSignal(link.ingredient ?? "");
  });
}

function removeBenefitSubsetRedundancy(values: string[]): string[] {
  const selected: Array<{ value: string; facets: Set<string> }> = [];
  for (const value of values) {
    const facets = benefitSemanticFacets(value);
    if (facets.size > 0 && selected.some((item) => item.facets.size > facets.size && Array.from(facets).every((facet) => item.facets.has(facet)))) {
      continue;
    }
    selected.push({ value, facets });
  }
  return selected.map((item) => item.value);
}

function benefitSemanticFacets(value: string): Set<string> {
  const text = cleanSignal(value).toLocaleLowerCase();
  return new Set([
    /anti[-\s]?aging|visible aging|노화|안티에이징/.test(text) ? "aging" : undefined,
    /hydration|moisture|moistur|수분|보습/.test(text) ? "hydration" : undefined,
    /firm|elastic|resilien|탄력/.test(text) ? "firmness" : undefined,
    /wrinkle|fine line|주름/.test(text) ? "wrinkle" : undefined,
    /barrier|장벽/.test(text) ? "barrier" : undefined,
    /sooth|calm|진정/.test(text) ? "soothing" : undefined,
    /texture|smooth|피부결/.test(text) ? "texture" : undefined
  ].filter((facet): facet is string => Boolean(facet)));
}

function isLowQualityBenefitSignal(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return true;
  }
  if (/[가-힣]/.test(text) && text.length > 48) {
    return true;
  }
  return /(?:성분은|성분이|설계되었습니다|자칫|함유되어|동일합니다|고객님|리뉴얼|어떤\s*성분|무엇인가요|효과\s*\*|REJUVENATING|CRÈME|AGREED)/i.test(text);
}

function isBenefitCompatibleWithProduct(value: string, product: PdpProductSignal): boolean {
  const benefit = cleanSignal(value);
  const productContext = cleanSignal([
    product.name,
    product.originalName,
    product.category,
    inferProductType(product)
  ].filter(Boolean).join(" "));
  const isCleanserProduct = /(?:클렌|세안|폼|워시|cleanser|cleansing|foam|wash)/i.test(productContext);
  if (/(?:저자극\s*세안|세정력|초미세먼지\s*세정|모공\s*속\s*노폐물\s*세정|마이크로\s*버블)/.test(benefit) && !isCleanserProduct) {
    return false;
  }
  return true;
}

function isProductEntityOnlySignal(value: string, product: PdpProductSignal): boolean {
  const normalized = signalEntityKey(value);
  return [
    product.name,
    product.originalName,
    product.brand,
    product.category
  ].filter((item): item is string => Boolean(item)).some((item) => normalized === signalEntityKey(item));
}

function signalEntityKey(value: string): string {
  return cleanSignal(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function selectBenefitSignals(product: PdpProductSignal): string[] {
  const faqBenefitText = product.faq
    .filter((item) => classifySourceFaqIntent(item).some((intent) => intent === "benefit" || intent === "suitability" || intent === "evidence"))
    .flatMap((item) => [item.question, item.answer]);
  return unique([
    ...product.benefits.flatMap(extractBenefitSignalCandidates),
    ...product.effects.flatMap(extractBenefitSignalCandidates),
    ...[product.description].filter((value): value is string => Boolean(value)).flatMap(extractBenefitSignalCandidates),
    ...(product.semanticFacts?.benefits ?? []).flatMap(extractBenefitSignalCandidates),
    ...(product.semanticFacts?.effects ?? []).flatMap(extractBenefitSignalCandidates),
    ...faqBenefitText.flatMap(extractBenefitSignalCandidates),
    ...selectBenefitEvidenceSourceTexts(product).flatMap(extractBenefitSignalCandidates)
  ].map(normalizeBenefitSignal).filter((value): value is string => Boolean(value)).filter(isUsefulBenefitSignal)).slice(0, 10);
}

function selectBenefitEvidenceSourceTexts(product: PdpProductSignal): string[] {
  const reviewKeys = new Set(product.reviews.items.map((item) => signalEntityKey(item.body)).filter(Boolean));
  return product.sourceTexts.slice(0, 60)
    .map(cleanSignal)
    .filter((value) => value.length >= 3 && value.length <= 320)
    .filter((value) => !reviewKeys.has(signalEntityKey(value)))
    .filter((value) => (value.match(/[?？]/g) ?? []).length <= 1)
    .filter((value) => !/(?:몇\s*(?:통|병|개)째|재구매|구매했|좋아요|좋습니다|마음에|만족하는|추천해요|더라고|네요|저는|제가|customer\s+review|repurchas|I\s+(?:bought|used|love|like|recommend))/iu.test(value));
}

function selectKeyIngredients(product: PdpProductSignal, limit: number): string[] {
  const ingredientEvidenceTexts = roleCoherentIngredientEvidenceTexts(product);
  const semanticIngredients = (product.semanticFacts?.ingredients ?? [])
    .flatMap(splitIngredientSignal)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value));
  const haystack = ingredientEvidenceTexts.join(" ");
  const evidenceIngredientSubjects = ingredientEvidenceTexts
    .flatMap(extractIngredientSubjectCandidates)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value));
  const detected = [
    ...extractConcreteIngredientTechnologySignals(haystack),
    /진세노믹스|ginsenomics/i.test(haystack) ? "진세노믹스" : undefined,
    /진생\s*펩타이드|진생펩타이드|ginseng peptide/i.test(haystack) ? "진생펩타이드" : undefined,
    /진생\s*레티놀|진생레티놀|ginseng retinol/i.test(haystack) ? "진생레티놀" : undefined,
    /500[-\s]?hour(?:\s+aged)?\s+ginseng/i.test(haystack) ? "500-hour aged ginseng" : undefined,
    /korean herb extract/i.test(haystack) ? "Korean herb extract" : undefined,
    /korean ginseng actives|ginsenomics/i.test(haystack) ? "Korean Ginseng Actives (Ginsenomics)" : undefined,
    /ginseng peptide/i.test(haystack) ? "Ginseng Peptide" : undefined,
    /retinol/i.test(haystack) ? "Retinol" : undefined,
    /niacinamide/i.test(haystack) ? "Niacinamide" : undefined,
    /hyaluronic|sodium hyaluronate/i.test(haystack) ? "Hyaluronic Acid" : undefined,
    /zinc/i.test(haystack) ? "Zinc" : undefined,
    /ceramide/i.test(haystack) ? "Ceramide" : undefined,
    /세라마이드/i.test(haystack) ? "세라마이드" : undefined,
    /히알루론산|하이알루론산/i.test(haystack) ? "히알루론산" : undefined,
    /징크/i.test(haystack) ? "징크" : undefined,
    /나이아신아마이드/i.test(haystack) ? "나이아신아마이드" : undefined,
    /panthenol|판테놀/i.test(haystack) ? "판테놀" : undefined,
    /betaine|베타인/i.test(haystack) ? "베타인" : undefined,
    /probiotics?|프로바이오틱스/i.test(haystack) ? "프로바이오틱스" : undefined
  ].filter((value): value is string => Boolean(value));
  const normalizedFromIngredients = product.ingredients
    .flatMap(splitIngredientSignal)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value));
  const normalizedFromSourceTexts = roleCoherentIngredientEvidenceTexts(product)
    .flatMap(splitIngredientSignal)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value))
    .filter(isGenericSourceIngredientSignal);

  return dedupeIngredientSignals([
    ...semanticIngredients,
    ...detected,
    ...evidenceIngredientSubjects,
    ...normalizedFromIngredients,
    ...(semanticIngredients.length === 0 ? normalizedFromSourceTexts : [])
  ])
    .filter((value) => isUsefulKeyIngredientSignal(value, product))
    .slice(0, limit);
}

function roleCoherentIngredientEvidenceTexts(product: PdpProductSignal): string[] {
  const reviewEvidenceKeys = new Set([
    ...product.reviews.items.map((item) => item.body),
    ...product.reviews.keywords
  ].map(signalEntityKey).filter(Boolean));
  const ingredientFaqEvidence = product.faq
    .filter((item) => classifySourceFaqIntent(item).includes("ingredient"))
    .flatMap((item) => [item.question, item.answer]);
  const explicitLinks = (product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [
    link.ingredient,
    link.sentence,
    link.sourceText
  ].filter((value): value is string => Boolean(value)));
  const sourceIngredientEvidence = product.sourceTexts.slice(0, 80)
    .map(cleanSignal)
    .filter(Boolean)
    .filter((value) => !reviewEvidenceKeys.has(signalEntityKey(value)))
    .filter(isExplicitIngredientEvidenceText);

  return unique([
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? []),
    ...explicitLinks,
    ...ingredientFaqEvidence,
    ...sourceIngredientEvidence
  ].map(cleanSignal).filter(Boolean));
}

function isExplicitIngredientEvidenceText(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || isIngredientAttributeOrOutcomeSignal(text) || isLowQualityIngredientEvidenceText(text)) {
    return false;
  }
  if (/^(?:ingredients?|key\s+ingredients?|actives?|전성분|주요\s*성분|핵심\s*성분|성분|원료)\s*[:：]/iu.test(text)) {
    return true;
  }
  return isGenericSourceIngredientSignal(text)
    || hasSpecificIngredientNameAnchor(text) && text.length <= 220;
}

function selectLocalizedKeyIngredients(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const localized = dedupePublicListValues(selectKeyIngredients(product, Math.max(limit * 2, limit))
    .map((value) => localizeDescriptionIngredientSurface(value, locale))
    .filter((value): value is string => Boolean(value)));
  const selected: string[] = [];
  const familyIndexes = new Map<string, number>();
  for (const value of localized) {
    const family = /ginsenomics|korean\s+ginseng\s+actives/i.test(value)
      ? "ginsenomics"
      : signalEntityKey(value);
    const existingIndex = familyIndexes.get(family);
    if (existingIndex === undefined) {
      familyIndexes.set(family, selected.length);
      selected.push(value);
      continue;
    }
    const existing = selected[existingIndex] ?? "";
    if (value.length > existing.length) {
      selected[existingIndex] = value;
    }
  }
  return selected.slice(0, limit);
}

function extractIngredientSubjectCandidates(value: string): string[] {
  const text = cleanSignal(value);
  if (!text || isLowQualityIngredientEvidenceText(text)) {
    return [];
  }
  const candidates: string[] = [];
  const subjectPattern = /(?:^|[.!?。！？]\s*|[,，]\s*)([가-힣A-Za-z0-9™®+\-/\s]{2,48}?)(?:은|는|is|are)\s+[^.!?。！？]{0,160}?(?:성분|기술|포뮬러|복합체|펩타이드|비타민|추출|사포닌|콜라겐|항산화|탄력|케어|ingredient|technology|formula|complex|peptide|vitamin|extract|active|antioxidant)/giu;
  for (const match of text.matchAll(subjectPattern)) {
    candidates.push(...splitIngredientSubjectCandidate(match[1] ?? ""));
  }
  return unique(candidates.map(cleanIngredientSubjectCandidate).filter((item): item is string => Boolean(item)));
}

function splitIngredientSubjectCandidate(value: string): string[] {
  return cleanSignal(value)
    .replace(/^(?:그리고|또한|특히|세\s*가지|핵심|주요|성분|기술|포뮬러|ingredients?|technolog(?:y|ies)|formula|include|includes|including|feature|features|highlight|highlights|구성|포함|으로|로|은|는|:)\s*/i, "")
    .split(/\s*(?:,|，|\/|\+|및|와|과|and)\s*/i)
    .map(cleanIngredientSubjectCandidate)
    .filter((item): item is string => Boolean(item));
}

function cleanIngredientSubjectCandidate(value: string): string | undefined {
  const text = cleanSignal(value)
    .replace(/^(?:그리고|또한|특히|핵심|주요)\s+/i, "")
    .replace(/(?:성분|기술|포뮬러|ingredients?|technolog(?:y|ies)|formula)\s*(?:으로|로|은|는|:)?$/i, "")
    .replace(/^(?:include|includes|including|feature|features|highlight|highlights|구성|포함)\s*/i, "")
    .replace(/\s*(?:에는|은|는|이|가|을|를|에)$/u, "")
    .trim();
  if (!text || text.length < 2 || text.length > 48 || isIngredientSectionLabel(text) || isLowQualityIngredientEvidenceText(text)) {
    return undefined;
  }
  if (/^(?:네|예|yes|no|성분|기술|포뮬러|핵심|주요|세\s*가지|제품|상품)$/i.test(text)) {
    return undefined;
  }
  if (/^(?:helping|supporting|improving|addressing|visibly|helps?|supports?|improves?|addresses?)\b/i.test(text)) {
    return undefined;
  }
  if (/(?:유지하|돕|케어|효능|효과|개선|느낌|사용감)$/.test(text) && !hasSpecificIngredientNameAnchor(text)) {
    return undefined;
  }
  if (/(?:^|[\s,])(?:캡슐|쿨링|효|주)$/.test(text) || /(?:쿨링\s*효|쿨링을\s*주|크림에\s*함유된\s*캡슐)/.test(text)) {
    return undefined;
  }
  return text;
}

function isGenericSourceIngredientSignal(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 80 || /[.。！？?]/.test(text) || isIngredientSectionLabel(text) || isLowQualityIngredientEvidenceText(text)) {
    return false;
  }
  if (/\b(?:oil|sebum)\s+(?:control|balance|care)|(?:control|balance)\s+(?:oil|sebum)\b/i.test(text)) {
    return false;
  }
  return /\b(?:ingredient|formula|technology|complex|blend|extract|acid|peptide|capsule|ferment|filtrate|root|leaf|seed|flower|fruit|ceramide|hyaluronic|retinol|niacinamide|zinc|panthenol|betaine|[\p{L}-]+\s+oil)\b/iu.test(text)
    || /(?:성분|원료|기술|포뮬러|복합체|추출물|오일|펩타이드|캡슐|발효|유도체|세라마이드|히알루론산|레티놀|나이아신아마이드|징크)/i.test(text);
}

function isUsefulKeyIngredientSignal(value: string, product: PdpProductSignal): boolean {
  const text = cleanSignal(value);
  if (!text || isProductEntityOnlySignal(text, product) || isIngredientSectionLabel(text) || isLowQualityIngredientEvidenceText(text)) {
    return false;
  }
  if (isIngredientAttributeOrOutcomeSignal(text)) {
    return false;
  }
  // A quantified test/measurement sentence may mention an ingredient, but it
  // is evidence about performance rather than an ingredient entity.
  if (hasQuantifiedReportedSignal(text) && hasMinimumReportedEvidenceContext(text)) {
    return false;
  }
  if (isBrokenIngredientFragment(text)) {
    return false;
  }
  if (isGenericMarketingIngredientToken(text)) {
    return false;
  }
  if (isProductOrAudienceIngredientNoise(text, product)) {
    return false;
  }
  const normalized = signalEntityKey(text);
  if (product.benefits.some((benefit) => normalized === signalEntityKey(benefit))) {
    return false;
  }
  if (/^(?:benefits?|effects?|usage|how to use|directions?|product details?|customer reviews?|reviews?|skin care|skincare product|facial cleanser|serum|cream|cleanser|foam)$/i.test(text)) {
    return false;
  }
  return true;
}

function isIngredientAttributeOrOutcomeSignal(value: string): boolean {
  const text = cleanSignal(value).toLocaleLowerCase();
  if (!text) return true;
  return /^(?:흡수력|유지력|지속력|보습력|전달력|침투력|밀착력|발림성|사용감|안정성|수분감|피부결|유분\s*컨트롤|피부\s*장벽|피부장벽|장벽보습|민감\s*피부|민감피부|건조\s*피부|견고한\s*구조|잔존\s*효과|보습\s*캡슐|캡슐\s*제형|비캡슐|연구|효능|효과|개선|완화|진정|absorption|absorbency|retention|persistence|delivery|penetration|spreadability|texture|finish|efficacy|effect|benefit|hydration|moisture|skin\s*barrier|sensitive\s*skin|dry\s*skin|oil\s*control|吸収力|持続力|使用感|保湿力|肌バリア|敏感肌|乾燥肌|効果|効能)$/iu.test(text);
}

function isGenericMarketingIngredientToken(value: string): boolean {
  const text = cleanSignal(value);
  if (/^(?:care|new|best|no\.?\s*1|premium|anti[-\s]?aging|product|formula|technology)$/i.test(text)) {
    return true;
  }
  if (/^(?:자생력|고밀도|피부|보습막|영양감|산뜻한|리치한|탄력|주름|수분감|피부결|장벽|방어력|효능|효과|케어)$/i.test(text)) {
    return true;
  }
  return /^[A-Z]{3,12}$/.test(text) && !hasSpecificIngredientNameAnchor(text);
}

function isBrokenIngredientFragment(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return true;
  }
  if (/^흔들\s*필요\s*없$/u.test(text)) {
    return true;
  }
  if (hasSpecificIngredientNameAnchor(text)) {
    return false;
  }
  if (/[가-힣]/.test(text) && /(?:않|아니|또|및|와|과|또는|그리고|으로|로|된|되는|되어|제시|설명|제공|확인)$/.test(text)) {
    return true;
  }
  return /(?:물에\s*녹지\s*않|피부\s*장벽|피부장벽|건조\s*피부|민감\s*피부|추천\s*피부)/.test(text);
}

function isProductOrAudienceIngredientNoise(value: string, product: PdpProductSignal): boolean {
  const text = cleanSignal(value);
  const normalized = signalEntityKey(text);
  const hasIngredientAnchor = hasSpecificIngredientNameAnchor(text);
  const productEntityContainsValue = [
    product.name,
    product.originalName
  ].filter((item): item is string => Boolean(item)).some((item) => {
    const key = signalEntityKey(item);
    return normalized.length >= 2 && key.includes(normalized);
  });
  if (productEntityContainsValue && !hasIngredientAnchor) {
    return true;
  }
  if (hasProductTypeToken(text) && !hasIngredientAnchor) {
    return true;
  }
  if (/(?:라인|컬렉션|제품군|line|collection|range)$/i.test(text) && !hasIngredientAnchor) {
    return true;
  }
  if (text.split(/\s+/).length >= 5 && !hasIngredientAnchor) {
    return true;
  }
  return /(?:고객|분|피부\s*타입|타입\s*전용|전용|제품|상품)$/i.test(text) && !hasIngredientAnchor;
}

function hasSpecificIngredientNameAnchor(value: string): boolean {
  return /(?:성분|원료|기술|공법|포뮬러|복합체|추출|오일|펩타이드|비타민|유도체|발효|사포닌|콜라겐|세라마이드|히알루론산|하이알루론산|레티놀|나이아신아마이드|징크|판테놀|베타인|프로바이오틱스|ingredient|formula|technology|method|process|complex|extract|oil|peptide|vitamin|derivative|ferment|saponin|collagen|ceramide|hyaluronic|retinol|niacinamide|zinc|panthenol|betaine|probiotics?|ginseng|panax)/i.test(cleanSignal(value));
}

function hasProductTypeToken(value: string): boolean {
  return /(?:크림|세럼|토너|로션|앰플|에센스|클렌저|클렌징|폼|마스크)(?:$|[\s\]\),.이가은는을를에와과])|\b(?:cream|serum|toner|lotion|ampoule|essence|cleanser|cleansing|foam|mask)\b/i.test(cleanSignal(value));
}

function isIngredientSectionLabel(value: string): boolean {
  return /^(?:ingredients?|ingredient list|key ingredients|full ingredients|core ingredients?|active ingredients?|benefits?|effects?|usage|how to use|directions?|전성분|주요 성분|핵심 성분|효능|사용법|추천 피부 타입|全成分)$/i.test(cleanSignal(value));
}

function dedupeIngredientSignals(values: string[]): string[] {
  const uniqueValues = unique(values);
  const hasRetinolCapsule = uniqueValues.some((value) => /retinol-infused capsules/i.test(value));
  const hasDenseCeramideCapsule = uniqueValues.some((value) => /고밀도\s*세라마이드\s*캡슐/i.test(value));
  const hasHydrogelFloatingFormula = uniqueValues.some((value) => /하이드로겔\s*플로팅\s*포뮬러/i.test(value));
  const hasCompressedHyaluronic = uniqueValues.some((value) => /압축\s*히알루론산/i.test(value));
  const hasSpecificGinseng = uniqueValues.some((value) =>
    /500[-\s]?hour|korean herb extract|korean ginseng actives|ginsenomics|ginseng peptide|panax ginseng|진세노믹스|진생\s*펩타이드|진생\s*레티놀/i.test(value)
  );

  return uniqueValues.filter((value) => {
    if (hasRetinolCapsule && /^retinol$/i.test(value)) {
      return false;
    }
    if (hasDenseCeramideCapsule && /^(?:세라마이드|세라마이드\s*캡슐)$/i.test(value)) {
      return false;
    }
    if (hasHydrogelFloatingFormula && /^하이드로겔\s*포뮬러$/i.test(value)) {
      return false;
    }
    if (hasCompressedHyaluronic && /^히알루론산$/i.test(value)) {
      return false;
    }
    if (hasSpecificGinseng && /^(?:ginseng|with the power of ginseng)$/i.test(value)) {
      return false;
    }
    return true;
  });
}

function selectIngredientDetails(product: PdpProductSignal, normalizedIngredients: string[], limit: number): string[] {
  const ingredientNames = normalizedIngredients.map((value) => value.toLowerCase());
  return unique(product.ingredients
    .map(stripSourceSectionLabel)
    .map(normalizeIngredientDetail)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNonCitationEvidenceArtifact(value))
    .filter((value) => value.length >= 35 && value.length <= 220)
    .filter((value) => !/^water\s*\/\s*aqua/i.test(value) && value.split(",").length <= 6)
    .filter((value) => ingredientNames.length === 0 || ingredientNames.some((ingredient) => value.toLowerCase().includes(ingredient.split(" ")[0] ?? ingredient)))
    .filter((value) => !hasTruncationMarker(value) && !isQuestionLikeText(value))
    .filter(isPublicIngredientDetailEvidence)).slice(0, limit);
}

function isPublicIngredientDetailEvidence(value: string): boolean {
  const text = cleanSignal(value);
  if (!text
    || hasFaqCitationNoise(text)
    || isQuestionLikeText(text)
    || isDanglingKoreanIngredientFragment(text)
    || /(?:알고\s*싶|궁금|문의|아래와?\s*같은\s*명칭|확인하실\s*수|현재\s+.{0,50}(?:총\s*)?\d+가지)/iu.test(text)) {
    return false;
  }
  if (!hasSpecificIngredientNameAnchor(text)) {
    return false;
  }
  return /(?:함유|포함|배합|구성|적용|설계|연결|보완|지지|돕|도움|지원|강화|개선|완화|유지|공급|충전|보습|수분|장벽|진정|탄력|피부결|흡수|지속|컨트롤|특허|공법|기술|포뮬러|contains?|includes?|formulated|blend|support|help|improv|reinforc|hydrat|moistur|barrier|sooth|firm|texture|absorb|lasting|control|patent|technology|formula)/iu.test(text);
}

function isDanglingKoreanIngredientFragment(value: string): boolean {
  const text = trimTrailingSentencePunctuation(cleanSignal(value));
  return /(?:들어가|함유되어|포함되어|배합되어|사용하고|사용되어|담겨|구성되어|적용되어)\s*(?:있|되|하|된|한)?$/u.test(text)
    || /(?:위한|통한|관한|대한|때문에|그리고|또는|및)$/u.test(text);
}

function selectFullIngredientStatements(product: PdpProductSignal, limit: number): string[] {
  return unique([
    ...product.ingredients,
    ...product.sourceTexts.slice(0, 60)
  ]
    .flatMap(splitFullIngredientCandidates)
    .map(normalizeFullIngredientStatement)
    .filter((value): value is string => Boolean(value)))
    .slice(0, limit);
}

function splitFullIngredientCandidates(value: string): string[] {
  const text = stripSourceSectionLabel(value);
  const explicit = text.match(/(?:ingredients?|전성분|全成分)\s*:\s*[\s\S]+/i)?.[0];

  if (explicit) {
    return [explicit];
  }

  return [text];
}

function normalizeFullIngredientStatement(value: string): string | undefined {
  const rawText = cleanSignal(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  const listStart = rawText.search(/\b(?:water\s*\/\s*aqua|aqua|정제수|水)\b/i);
  const text = listStart > 30 ? rawText.slice(listStart).trim() : rawText;

  if (text.length < 30 || text.length > 1800 || isCommerceOrNavigationText(text)) {
    return undefined;
  }

  const hasExplicitLabel = /^(ingredients?|전성분|全成分)\s*:/i.test(text);
  const looksLikeIngredientList = /water\s*\/\s*aqua|aqua|glycerin|butylene glycol|panax|niacinamide|retinol|peptide|extract|정제수|글리세린|추출물/i.test(text)
    && (text.split(",").length >= 4 || text.split(/\s*\/\s*/).length >= 4);

  if (!hasExplicitLabel && !looksLikeIngredientList) {
    return undefined;
  }

  return truncate(text, 1200);
}

function formatFullIngredientStatement(value: string, locale: PdpGeoLocale): string {
  const withoutLabel = value.replace(/^(ingredients?|전성분|全成分)\s*:\s*/i, "").trim();
  const label = fallback(locale, {
    "ko-KR": "전성분",
    "ja-JP": "全成分",
    "en-US": "Full ingredients",
    "en-GB": "Full ingredients"
  });

  return `${label}: ${withoutLabel}`;
}

function normalizeIngredientDetail(value: string): string | undefined {
  const text = normalizePublicFactText(value)
    .replace(/\s+-\s+/g, ": ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || /^water\s*\/\s*aqua/i.test(text)) {
    return undefined;
  }
  if (text.length > 170 || /[A-Z]{4,}.*[A-Z]{4,}.*[A-Z]{4,}/.test(text)) {
    return undefined;
  }

  return text;
}

function selectUsageInstructions(product: PdpProductSignal): string[] {
  const instructions = selectUsageInstructionCandidateTexts(product)
    .map(normalizeUsageInstruction)
    .filter(isUsageInstruction)
    .filter((instruction) => !isConflictingProductUsageInstruction(instruction, product))
    .sort((a, b) => usageInstructionQualityScore(b) - usageInstructionQualityScore(a) || b.length - a.length);
  const deduped: string[] = [];

  for (const instruction of instructions) {
    const normalized = usageStepKey(instruction);
    if (deduped.some((item) => {
      return usageStepsAreSemanticallyEquivalent(item, instruction);
    })) {
      continue;
    }
    deduped.push(instruction);
  }

  return deduped.slice(0, 4);
}

function selectUsageInstructionCandidateTexts(product: PdpProductSignal): string[] {
  const sourceCandidates = product.sourceTexts
    .filter(hasOfficialUsageInstructionSectionCue)
    .flatMap(extractUsageInstructionCandidatesFromMixedText);
  const adjacentSourceCandidates = selectAdjacentUsageInstructionSourceTexts(product.sourceTexts)
    .flatMap(extractUsageInstructionCandidatesFromMixedText);

  return unique([
    ...(product.semanticFacts?.usageSteps ?? []),
    ...product.usage,
    ...sourceCandidates,
    ...adjacentSourceCandidates
  ]);
}

function selectAdjacentUsageInstructionSourceTexts(sourceTexts: string[]): string[] {
  const candidates: string[] = [];
  sourceTexts.forEach((text, index) => {
    if (!hasOfficialUsageInstructionSectionCue(text)) {
      return;
    }
    for (let offset = 1; offset <= 4; offset += 1) {
      const next = sourceTexts[index + offset];
      if (!next || hasOfficialUsageInstructionSectionCue(next) || isLikelyNonUsageSectionBoundary(next)) {
        break;
      }
      candidates.push(next);
    }
  });
  return candidates;
}

function extractUsageInstructionCandidatesFromMixedText(value: string): string[] {
  const normalized = cleanSignal(value);
  if (!normalized || !hasSupplementalUsageInstructionCue(normalized)) {
    return [];
  }

  const candidate = normalizeUsageInstruction(normalized);
  return unique([
    ...splitUsageInstructionSegments(normalized).map(normalizeUsageInstruction),
    candidate
  ].filter((item): item is string => Boolean(item)));
}

function hasSupplementalUsageInstructionCue(value: string): boolean {
  return /사용\s*방법|사용법\s*\d*|\bhow\s+to\s+use\b|\bdirections?\b|손에\s*적당량|적당량|화장솜|피부결|펴\s*발|두드려|흡수(?!감)|미온수|헹구|마무리(?:해|하세요|합니다|하십시오)|lather|rinse|apply|spread|pat|absorb/i.test(value);
}

function hasOfficialUsageInstructionSectionCue(value: string): boolean {
  return /(?:사용\s*방법|사용법\s*\d*|사용\s*순서|사용\s*단계|\bhow\s+to\s+use\b|\bdirections?\b)/i.test(value);
}

function isLikelyNonUsageSectionBoundary(value: string): boolean {
  const text = cleanSignal(value);
  return /^(?:FAQ|Q\.|자주\s*묻는\s*질문|전성분|성분|효능|효과|리뷰|상품\s*정보|제품\s*정보|구매|가격)\b/i.test(text)
    || /(?:추천\s*피부|피부\s*타입|시험|테스트|리뷰|별점|가격|쿠폰|배송)/i.test(text);
}

function usageInstructionQualityScore(value: string): number {
  const normalized = cleanSignal(value);
  return [
    /(?:적당량|dime-sized|pea-sized|small amount|appropriate amount)/i.test(normalized) ? 4 : 0,
    /(?:물과\s*함께|wet|water|거품\s*내|거품내|lather)/i.test(normalized) ? 4 : 0,
    /(?:마사지|문지르|massage|rub)/i.test(normalized) ? 3 : 0,
    /(?:헹구|마무리(?:해|하세요|합니다|하십시오)|rinse)/i.test(normalized) ? 3 : 0,
    /(?:얼굴|face|skin)/i.test(normalized) ? 2 : 0,
    /\d/.test(normalized) ? -1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function selectReviewKeywords(product: PdpProductSignal): string[] {
  return unique(product.reviews.keywords
    .map(normalizeReviewKeyword)
    .filter((value): value is string => Boolean(value))
    .filter(isReviewKeyword)).slice(0, 8);
}

function selectPublicReviewKeywords(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  return dedupePublicListValues(selectReviewKeywords(product)
    .map((value) => localizePublicReviewKeyword(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isUsefulPublicListValue))
    .slice(0, 8);
}

function selectReviewIntentFaqKeywords(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  return selectPublicReviewKeywords(product, locale)
    .filter((value) => !isNegativeReviewSignalText(value))
    .slice(0, 5);
}

function normalizeReviewKeyword(value: string): string | undefined {
  const normalized = normalizePublicReviewKeywordSurface(cleanSignal(value).replace(/\.$/, ""));
  if (!normalized) {
    return undefined;
  }
  if (/^smoother|smoothness|smooth$/i.test(normalized)) {
    return "smooth";
  }
  if (/^firmer|firming|firm$/i.test(normalized)) {
    return "firmness";
  }
  if (/^moisturizing|moisturising|moisturized|moisturised|moist$/i.test(normalized)) {
    return "moisture";
  }
  if (/^elastic|elasticity$/i.test(normalized)) {
    return "elasticity";
  }
  if (/^plump|plumping|plumpness$/i.test(normalized)) {
    return "plumpness";
  }
  return normalized;
}

function localizePublicReviewKeyword(value: string, locale: PdpGeoLocale): string | undefined {
  const normalized = normalizePublicReviewKeywordSurface(cleanSignal(value)
    .replace(/[,.]$/g, "")
    .trim());
  if (!normalized || hasTruncationMarker(normalized) || isQuestionLikeText(normalized) || isBrokenMarketingFragment(normalized)) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const mappings: Array<[RegExp, string]> = [
      [/^hydration$|^moisture$|^moist$|^보습$|수분감|보습감/i, "촉촉한 사용감"],
      [/^smooth texture$|^smooth$|texture|피부결|매끄/i, "피부결"],
      [/촉촉/i, "촉촉한 사용감"],
      [/보습력/i, "보습력"],
      [/자극\s*(?:없|없이|적)/u, "자극 없이 편안한 사용감"],
      [/끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않/u, "끈적임이 적은 마무리"],
      [/흡수/i, "흡수감"],
      [/탄력|firmness|elasticity/i, "탄력"],
      [/순한|민감/i, "순한 사용감"],
      [/만족/i, "만족도"],
      [/광채|glow/i, "광채"]
    ];
    for (const [pattern, replacement] of mappings) {
      if (pattern.test(normalized)) {
        return replacement;
      }
    }
    return /[가-힣]/.test(normalized) && !/[A-Za-z]/.test(normalized) ? normalized : undefined;
  }

  if (locale === "ja-JP") {
    const mappings: Array<[RegExp, string]> = [
      [/hydration|moisture|保湿|うるおい/i, "うるおい"],
      [/smooth|texture|キメ/i, "キメ"],
      [/firmness|elasticity|ハリ/i, "ハリ"],
      [/なじみ/i, "肌なじみ"],
      [/満足/i, "満足感"]
    ];
    for (const [pattern, replacement] of mappings) {
      if (pattern.test(normalized)) {
        return replacement;
      }
    }
  }

  if (locale === "en-US" || locale === "en-GB") {
    const mappings: Array<[RegExp, string]> = [
      [/피부결|매끄/u, "smooth texture"],
      [/만족/u, "satisfaction"],
      [/보습력|보습감|촉촉/u, "moisturizing feel"],
      [/수분감/u, "hydrating feel"],
      [/흡수/u, "absorption"],
      [/순한|민감/u, "gentle feel"],
      [/끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않/u, "non-sticky finish"],
      [/탄력/u, "firmness"],
      [/광채/u, "glow"]
    ];
    for (const [pattern, replacement] of mappings) {
      if (pattern.test(normalized)) {
        return replacement;
      }
    }
    return /[가-힣ぁ-んァ-ン]/u.test(normalized) ? undefined : normalized;
  }

  return normalized;
}

function normalizePublicReviewKeywordSurface(value: string): string {
  let text = cleanSignal(value)
    .replace(/\s*같은\s*표현.*$/u, "")
    .replace(/\s*review\s+language.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/[가-힣]/.test(text) && !/[A-Za-z]/.test(text)) {
    text = text.replace(/\s*(?:을|를|이|가|은|는|으로|로)$/u, "");
  }

  return text.trim();
}

function normalizePublicReviewBody(value: string, locale: PdpGeoLocale): string {
  const normalized = cleanSignal(value)
    .replace(/\\[rn]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, addSentencePunctuationSpacing)
    .trim();

  return normalized;
}

function selectReviewItems(product: PdpProductSignal, locale: PdpGeoLocale): PdpGeoReviewItem[] {
  const seen = new Set<string>();
  return product.reviews.items
    .map((review) => ({
      ...review,
      body: normalizePublicReviewBody(review.body, locale)
    }))
    .filter((review) => isNarrativeLocaleCompatible(review.body, locale))
    .filter((review) => !isProductNameOnlyReviewBody(review.body, product))
    .filter((review) => !isConflictingProductReviewBody(review.body, product))
    .filter((review) => isMeaningfulReviewBody(review.body))
    .filter((review) => {
      const key = review.body.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function isConflictingProductReviewBody(value: string, product: PdpProductSignal): boolean {
  const text = cleanSignal(value);
  const productContext = cleanSignal([product.name, product.originalName, product.category, inferProductType(product)].filter(Boolean).join(" "));
  const productIsCleanser = /(?:클렌|세안|폼|워시|cleanser|cleansing|foam|wash)/iu.test(productContext);
  const cleanserSignals = [
    /(?:클렌저|클렌징|세안제|거품제)/iu,
    /(?:거품을?\s*내|거품으로\s*롤링|버블|헹구)/iu,
    /(?:세정력|노폐물\s*세정|메이크업\s*세정)/iu
  ].filter((pattern) => pattern.test(text)).length;
  return !productIsCleanser && cleanserSignals >= 2;
}

function hasPublicReviewEvidence(product: PdpProductSignal, locale: PdpGeoLocale): boolean {
  return selectReviewItems(product, locale).length > 0
    || (typeof product.reviews.rating === "number" && product.reviews.rating > 0 && typeof product.reviews.reviewCount === "number" && product.reviews.reviewCount > 0);
}

function isProductNameOnlyReviewBody(value: string, product: PdpProductSignal): boolean {
  const normalized = signalEntityKey(value);
  return [
    product.name,
    product.originalName
  ].filter((item): item is string => Boolean(item)).some((item) => normalized === signalEntityKey(item));
}

function selectRepresentativeReviewPhrases(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return unique(product.reviews.items
    .filter((review) => !isProductNameOnlyReviewBody(review.body, product))
    .map((review) => normalizeRepresentativeReviewPhrase(stripProductEntityFromReviewPhrase(review.body, product), locale))
    .filter((value): value is string => Boolean(value))).slice(0, limit);
}

function stripProductEntityFromReviewPhrase(value: string, product: PdpProductSignal): string {
  return unique([product.name, product.originalName]
    .map((entity) => cleanSignal(entity ?? ""))
    .filter(Boolean))
    .sort((left, right) => right.length - left.length)
    .reduce((current, entity) => {
      const tokens = entity.split(/\s+/u).filter(Boolean);
      if (tokens.length === 0) {
        return current;
      }
      return current.replace(new RegExp(tokens.map(escapeRegExp).join("\\s+"), "giu"), " ");
    }, value)
    .replace(/^[\s,;:–—-]+/u, "")
    .replace(/\s+([,.!?。！？])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeRepresentativeReviewPhrase(value: string, locale: PdpGeoLocale): string | undefined {
  const normalized = normalizePublicReviewBody(value, locale)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .trim();

  if (!isRepresentativeReviewPhrase(normalized)) {
    return undefined;
  }

  return locale === "ko-KR" ? summarizeKoreanReviewPhrase(normalized) ?? normalized : normalized;
}

function summarizeKoreanReviewPhrase(value: string): string | undefined {
  const signals = [
    /속당김|건조함/.test(value) ? "속당김과 건조함 완화" : undefined,
    /가벼/.test(value) ? "가벼운 사용감" : undefined,
    /수분감|수분/.test(value) ? "수분감" : undefined,
    /촉촉/.test(value) ? "촉촉한 사용감" : undefined,
    /보습력|보습/.test(value) ? "보습력" : undefined,
    /피부결/.test(value) ? "피부결" : undefined,
    /무향|향도 무향/.test(value) ? "무향 사용감" : undefined
  ].filter((item): item is string => Boolean(item));

  return signals.length > 0 ? unique(signals).slice(0, 3).join(", ") : undefined;
}

function isRepresentativeReviewPhrase(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 220) {
    return false;
  }
  if (isRatingSummaryText(normalized)) {
    return false;
  }
  if (/^(review|reviews|rating|ratings|star|stars|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }
  return /[가-힣ぁ-んァ-ン]/.test(normalized)
    || normalized.split(/\s+/).length >= 5
    || /absorbs?|smooth|moist|firm|elastic|plump|texture|glow|lightweight|rich|촉촉|흡수|탄력|피부결|保湿|うるおい|ハリ|なじみ/i.test(normalized);
}

function selectEvidenceSignal(product: PdpProductSignal, locale: PdpGeoLocale = "en-US"): string | undefined {
  const structuredMetric = first(selectStructuredReportedMetricDetails(product, locale, 1));
  const reportedDetail = first(selectReportedDetails(product, 1));
  const sourceBackedSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const sourceBackedSentence = locale === "ko-KR"
    ? sourceBackedSentences[4] ?? sourceBackedSentences[3] ?? sourceBackedSentences[2] ?? sourceBackedSentences[1] ?? sourceBackedSentences[0]
    : sourceBackedSentences[0];
  const metric = first(product.metrics
    .filter((metricValue) => !isNonCitationEvidenceArtifact(metricValue))
    .filter(isCitationEvidenceMetric)
    .filter((metricValue) => !isTerseDurationMetric(metricValue))
    .slice(0, 3));
  const rating = product.reviews.rating ? `${product.reviews.rating}${product.reviews.reviewCount ? ` / ${product.reviews.reviewCount} reviews` : " rating"}` : undefined;
  const review = first(selectPublicReviewKeywords(product, locale).slice(0, 3));

  return first([
    structuredMetric,
    reportedDetail,
    sourceBackedSentence,
    metric,
    rating,
    review ? fallback(locale, {
      "ko-KR": `고객 리뷰 표현: ${review}`,
      "ja-JP": `レビュー表現: ${review}`,
      "en-US": `review language: ${review}`,
      "en-GB": `review language: ${review}`
    }) : undefined,
    product.description ? normalizePublicEvidenceText(product.description, locale) : undefined
  ]);
}

function selectSourceBackedClaimSentences(product: PdpProductSignal, limit: number): string[] {
  return unique([
    ...(product.semanticFacts?.evidenceSentences ?? []),
    ...(product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [link.sentence, link.sourceText].filter((value): value is string => Boolean(value))),
    ...product.effects,
    ...product.benefits,
    ...product.ingredients,
    ...product.sourceTexts.slice(0, 40)
  ]
    .flatMap(splitClaimSentences)
    .map(normalizeSourceBackedClaimSentence)
    .filter((value): value is string => Boolean(value)))
    .slice(0, limit);
}

function selectOptimizedSourceBackedClaimSentences(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const optimized = unique(selectSourceBackedClaimSentences(product, limit * 3)
    .map((sentence) => composeGeoOptimizedClaimSentence(product, sentence, locale))
    .filter((value): value is string => Boolean(value)))
    .slice(0, limit);

  if (optimized.length >= limit) {
    return optimized;
  }

  return unique([
    ...optimized,
    ...selectFallbackGeoClaimSentences(product, locale, limit)
  ]).slice(0, limit);
}

function selectFallbackGeoClaimSentences(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  if (locale === "ko-KR") {
    return selectKoreanFallbackGeoClaimSentences(product, locale, limit);
  }
  if (locale === "en-US" || locale === "en-GB") {
    return selectEnglishFallbackGeoClaimSentences(product, locale, limit);
  }
  return [];
}

function selectKoreanFallbackGeoClaimSentences(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 3);
  const outcomes = selectPublicBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const outcomePhrase = formatDescriptionList(outcomes, locale, 4);
  const rawProductType = resolveProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : "제품";
  const targetCustomer = inferTargetCustomer(product, locale);
  const reviewPhrase = hasPublicReviewEvidence(product, locale) ? formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4) : undefined;
  const usage = first(selectUsageInstructions(product).filter((value) => isNarrativeLocaleCompatible(value, locale)));

  if (!ingredientPhrase || !outcomePhrase) {
    return [];
  }

  return unique([
    createKoreanGeoClaimSentence(ingredientPhrase, outcomePhrase, productType, 0),
    createKoreanIngredientBenefitSentence(ingredientPhrase, outcomePhrase, targetCustomer),
    createKoreanComparisonIntentSentence(productType, outcomePhrase, targetCustomer),
    reviewPhrase ? createKoreanReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase) : undefined,
    usage ? createKoreanUsageBenefitSentence(usage, outcomePhrase, first(ingredients)) : undefined,
    createKoreanCareKeywordSentence(ingredientPhrase, outcomePhrase, reviewPhrase),
    createKoreanConcernRoutineSentence(productType, targetCustomer, outcomePhrase, usage)
  ].filter((value): value is string => Boolean(value))).slice(0, limit);
}

function selectEnglishFallbackGeoClaimSentences(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 3);
  const outcomes = selectPublicBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const outcomePhrase = formatDescriptionList(outcomes, locale, 4);
  const rawProductType = resolveProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : "product";
  const targetCustomer = inferTargetCustomer(product, locale);
  const reviewPhrase = hasPublicReviewEvidence(product, locale) ? formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4) : undefined;
  const usage = first(selectUsageInstructions(product));

  if (!ingredientPhrase || !outcomePhrase) {
    return [];
  }

  return unique([
    createEnglishGeoClaimSentence(ingredientPhrase, outcomePhrase, productType, 0),
    createEnglishIngredientBenefitSentence(ingredientPhrase, outcomePhrase, targetCustomer),
    createEnglishComparisonIntentSentence(productType, outcomePhrase, targetCustomer),
    reviewPhrase ? createEnglishReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase) : undefined,
    usage ? createEnglishUsageBenefitSentence(usage, outcomePhrase, first(ingredients)) : undefined,
    createEnglishCareKeywordSentence(ingredientPhrase, outcomePhrase, reviewPhrase),
    createEnglishConcernRoutineSentence(productType, targetCustomer, outcomePhrase, usage)
  ].filter((value): value is string => Boolean(value))).slice(0, limit);
}

function selectGroundedExpressionPhrases(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 4);
  const conciseIngredients = selectConcisePositiveNoteIngredients(ingredients);
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 5);
  const reviews = hasPublicReviewEvidence(product, locale) ? selectPublicReviewKeywords(product, locale).slice(0, 4) : [];
  const rawProductType = resolveProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const ingredientPhrase = formatDescriptionList(conciseIngredients, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 4);
  const reviewPhrase = formatDescriptionList(reviews, locale, 3);
  const primaryIngredient = conciseIngredients[0];
  const secondaryIngredient = conciseIngredients[1];

  if (locale === "ko-KR") {
    return unique([
      ingredientPhrase && benefitPhrase ? `${formatKoreanListForSentence(ingredientPhrase)} 기반 ${benefitPhrase} 케어` : undefined,
      primaryIngredient && benefits[0] ? `${primaryIngredient} ${benefits[0]} 포인트` : undefined,
      secondaryIngredient && benefits[1] ? `${secondaryIngredient} ${benefits[1]} 포인트` : undefined,
      benefitPhrase ? `${benefitPhrase} 효능` : undefined,
      reviewPhrase ? `${reviewPhrase} 리뷰 표현` : undefined,
      benefitPhrase ? `${benefitPhrase} ${productType}` : undefined
    ].filter((value): value is string => Boolean(value))
      .map(cleanSignal)
      .filter(isUsefulPublicListValue))
      .slice(0, limit);
  }

  if (locale === "ja-JP") {
    return unique([
      ingredientPhrase && benefitPhrase ? `${ingredientPhrase}と${benefitPhrase}` : undefined,
      ingredients[0] && benefits[0] ? `${ingredients[0]} ${benefits[0]}` : undefined,
      benefitPhrase ? `${productType}の${benefitPhrase}` : undefined,
      reviewPhrase ? `レビューで見られる${reviewPhrase}` : undefined
    ].filter((value): value is string => Boolean(value))
      .map(cleanSignal)
      .filter(isUsefulPublicListValue))
      .slice(0, limit);
  }

  return unique([
    ingredientPhrase && benefitPhrase ? `${ingredientPhrase} for ${benefitPhrase}` : undefined,
    primaryIngredient && benefits[0] ? `${benefits[0]} with ${primaryIngredient}` : undefined,
    secondaryIngredient && benefits[1] ? `${benefits[1]} with ${secondaryIngredient}` : undefined,
    benefitPhrase ? `${lowercaseEnglishProductType(productType)} for ${benefitPhrase}` : undefined,
    reviewPhrase ? `customer-described ${reviewPhrase}` : undefined
  ].filter((value): value is string => Boolean(value))
    .map(cleanSignal)
    .filter(isUsefulPublicListValue))
    .slice(0, limit);
}

function selectConcisePositiveNoteIngredients(values: string[]): string[] {
  return unique(values
    .flatMap((value) => cleanSignal(value).split(/\s*,\s*|\/|·/))
    .map((value) => value
      .replace(/^성분(?:으로|은|는)?\s*/u, "")
      .replace(/\s*성분\/기술$/u, "")
      .replace(/\s*기반$/u, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((value) => value.length >= 2 && value.length <= 36)
    .filter((value) => !/(?:고객님|리뉴얼|동일|설계|효능어|성분어|포인트|케어\s*케어)/u.test(value)));
}

function formatExpressionPhrases(values: Array<string | undefined>, locale: PdpGeoLocale): string | undefined {
  const phrases = values
    .map((value) => cleanSignal(value ?? "").replace(/[.。！？?]$/g, ""))
    .filter(Boolean)
    .filter(isUsefulPublicListValue);

  return formatDescriptionList(phrases, locale, locale === "ko-KR" ? 5 : 4);
}

interface OcrEvidenceInsight {
  topic: string;
  detail: string;
  text: string;
  intents: Array<"ingredient" | "benefit" | "usage" | "review">;
}

interface OcrFaqBlendContexts {
  benefit?: string;
  ingredient?: string;
  usage?: string;
}

interface PublicOcrFaqInsight {
  insight: OcrEvidenceInsight;
  topic?: string;
  detail?: string;
}

function selectOcrEvidenceInsights(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): OcrEvidenceInsight[] {
  const values = unique([
    ...product.sourceTexts,
    ...product.ingredients,
    ...product.effects,
    ...product.benefits,
    ...product.usage
  ]);
  const insights = values
    .map((value) => parseOcrEvidenceInsight(value, locale))
    .filter((value): value is OcrEvidenceInsight => Boolean(value));
  const seen = new Set<string>();
  const results: OcrEvidenceInsight[] = [];

  for (const insight of insights) {
    const key = `${insight.topic.toLowerCase()}:${insight.detail.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(insight);
  }

  return results.slice(0, limit);
}

function parseOcrEvidenceInsight(value: string, locale: PdpGeoLocale): OcrEvidenceInsight | undefined {
  const text = cleanSignal(value).replace(/\s+/g, " ").trim();
  const match = text.match(/^(.{2,64}?)[.:]\s+(.{10,})$/);
  if (!match) {
    return undefined;
  }

  const topic = cleanSignal(match[1] ?? "");
  const detail = trimTrailingSentencePunctuation(cleanSignal(match[2] ?? ""));
  if (!topic || !detail || topic.length > 60 || detail.length < 10 || detail.length > 420) {
    return undefined;
  }
  if (isQuestionLikeText(topic) || isQuestionLikeText(detail) || isNonCitationEvidenceArtifact(text) || isCommerceOrNavigationText(text)) {
    return undefined;
  }

  const intents = inferOcrEvidenceIntents(`${topic} ${detail}`, locale);
  if (intents.length === 0) {
    return undefined;
  }

  return {
    topic,
    detail,
    text: `${topic}. ${detail}`,
    intents
  };
}

function inferOcrEvidenceIntents(value: string, _locale: PdpGeoLocale): OcrEvidenceInsight["intents"] {
  const text = cleanSignal(value);
  const intents: OcrEvidenceInsight["intents"] = [];
  if (/ingredient|active|actives?|formula|technology|tech|성분|기술|히알루론산|하이알루론산|세라마이드|징크|zinc|ceramide|hyaluronic|retinol|niacinamide|peptide|ginseng|panthenol|capsule|캡슐/i.test(text)) {
    intents.push("ingredient");
  }
  if (/benefit|effect|hydration|moisture|barrier|soothing|firm|elastic|texture|comfort|oil|sebum|lasting|효능|효과|수분|보습|장벽|피지|유분|컨트롤|밸런스|진정|탄력|피부결|쿨링|흡수|지속|충전/i.test(text)) {
    intents.push("benefit");
  }
  if (/apply|use|morning|night|routine|step|사용|도포|바르|루틴|아침|저녁/i.test(text)) {
    intents.push("usage");
  }
  if (/review|customer|rating|satisfaction|리뷰|후기|고객|만족/i.test(text)) {
    intents.push("review");
  }
  return Array.from(new Set(intents));
}

function createOcrBlendedBenefitContexts(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  return selectOcrEvidenceInsights(product, locale, 6)
    .filter((insight) => insight.intents.includes("benefit") || insight.intents.includes("ingredient"))
    .filter((insight) => isPublicOcrBenefitInsight(insight, product, locale))
    .map((insight, index) => createOcrBlendedBenefitContext(product, insight, locale, index))
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);
}

function isPublicOcrBenefitInsight(insight: OcrEvidenceInsight, product: PdpProductSignal, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(insight.text);
  const commaCount = (text.match(/,/g) ?? []).length;
  if (!text
    || insight.intents.includes("review")
    || insight.detail.length > 260
    || (/^(?:ingredients?|full\s+ingredients?|전성분)\s*[:：]?/i.test(text) && commaCount >= 5)
    || commaCount >= 12
    || hasTruncationMarker(text)
    || isQuestionLikeText(text)
    || /[?？]/u.test(text)
    || /(?:알고\s*싶|궁금|문의|FAQ)/iu.test(text)
    || /(?:몇\s*(?:통|병|개)째|재구매|구매했|사용\s*중|사용해\s*보|써\s*보|좋아요|좋습니다|마음에|만족|추천해요|더라고|네요|저는|제가|우리\s*(?:아이|아기)|리뷰|후기|customer\s+review|repurchas|I\s+(?:bought|used|love|like|recommend))/iu.test(text)) {
    return false;
  }
  const compatibleBenefits = extractCanonicalBenefitTerms(text)
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => isBenefitCompatibleWithProduct(value, product));
  return insight.intents.includes("ingredient") || compatibleBenefits.length > 0;
}

function createOcrBlendedBenefitContext(product: PdpProductSignal, insight: OcrEvidenceInsight, locale: PdpGeoLocale, index: number): string | undefined {
  const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "product", locale);
  const outcomeValues = extractCanonicalBenefitTerms(insight.text)
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => isBenefitCompatibleWithProduct(value, product));
  const outcomes = formatDescriptionList(outcomeValues, locale, 3);
  const detail = trimTrailingSentencePunctuation(insight.detail);

  if (locale === "ko-KR") {
    return `${insight.topic}: ${detail}`;
  }

  const outcomePhrase = outcomes ?? "ingredient, benefit, and texture detail";
  const variants = [
    `${insight.topic} details mention ${detail}, adding context for ${outcomePhrase} in the ${lowercaseEnglishProductType(productType)}`,
    `${insight.topic} connects ${detail} with ${outcomePhrase} in the product evidence`,
    `${insight.topic} gives formula context through ${detail} for shoppers comparing the ${lowercaseEnglishProductType(productType)}`
  ];
  return variants[index % variants.length];
}

function createOcrFaqBlendContexts(product: PdpProductSignal, locale: PdpGeoLocale): OcrFaqBlendContexts {
  // OCR facts have already been classified into semantic roles before FAQ
  // rendering. Re-synthesizing topics and outcomes here can accidentally join
  // unrelated co-occurring terms into a causal claim. Only reuse a sentence
  // from an accepted ingredient-benefit link, and keep it in the ingredient
  // answer where its provenance is clear.
  const evidenceSentence = first((product.semanticFacts?.ingredientBenefitLinks ?? [])
    .map((link) => cleanSignal(link.sentence ?? link.sourceText ?? ""))
    .filter((value) => value.length >= 12 && value.length <= 280)
    .filter((value) => isNarrativeLocaleCompatible(value, locale))
    .filter((value) => !isQuestionLikeText(value) && !isLowQualityPublicEvidenceText(value)));
  if (!evidenceSentence) {
    return {};
  }
  const directSentence = normalizeFaqAnswerForDirectVoice(evidenceSentence, locale, product.name);
  return directSentence ? { ingredient: ensurePublicSentence(directSentence, locale) } : {};
}

function selectOcrGeoExposureTopics(product: PdpProductSignal, insights: PublicOcrFaqInsight[], locale: PdpGeoLocale): string[] {
  const candidates = unique([
    ...insights.flatMap((item) => [
      item.topic,
      ...extractCanonicalBenefitTerms(item.insight.text).map((value) => localizePublicBenefitSignal(value, locale)),
      normalizeIngredientSignal(item.insight.text)
    ]),
    ...selectLocalizedKeyIngredients(product, locale, 4),
    ...selectPublicBenefitSignals(product, locale).slice(0, 3)
  ].filter((value): value is string => Boolean(value)));

  return candidates
    .flatMap((value) => splitOcrGeoExposureTopic(value))
    .map((value) => normalizeOcrGeoExposureTopic(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isUsefulPublicListValue)
    .slice(0, 5);
}

function splitOcrGeoExposureTopic(value: string): string[] {
  return cleanSignal(value)
    .split(/\s*,\s*|\s*[|/]\s*|\s+및\s+|\s+와\s+|\s+과\s+/)
    .map(cleanSignal)
    .filter(Boolean);
}

function normalizeOcrGeoExposureTopic(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value)
    .replace(/(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/g, " ")
    .replace(/\b(?:before|after)\s+use\b/gi, " ")
    .replace(/[☑□■●◆]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isRawOcrHeadingArtifact(text) || isKoreanOcrTimingOnlyTopic(text)) {
    return undefined;
  }
  const ingredient = normalizeIngredientSignal(text);
  if (ingredient) {
    return ingredient;
  }
  const benefits = unique(extractCanonicalBenefitTerms(text)
    .map((term) => localizePublicBenefitSignal(term, locale))
    .filter((term): term is string => Boolean(term)));
  if (benefits.length > 0) {
    return formatDescriptionList(benefits, locale, 3);
  }
  if (text.length > 40 || /^(?:캡슐|토너|크림|세럼|제품|상품)$/i.test(text)) {
    return undefined;
  }
  return text;
}

function isKoreanOcrTimingOnlyTopic(value: string): boolean {
  const text = cleanSignal(value);
  return /^(?:사용|도포|세정)?\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)(?:\s+(?:사용|도포|세정)?\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후))*$/u.test(text);
}

function normalizeKoreanOcrSemanticDetail(value: string | undefined): string | undefined {
  const text = cleanSignal(value ?? "")
    .replace(/(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/g, " ")
    .replace(/[☑□■●◆]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text
    || text.length < 8
    || text.length > 120
    || isKoreanOcrTimingOnlyTopic(text)
    || isNonCitationEvidenceArtifact(text)
    || isHardEvidenceSignal(text)
    || hasFaqCitationNoise(text)) {
    return undefined;
  }
  const outcomes = unique(extractCanonicalBenefitTerms(text)
    .map((term) => localizePublicBenefitSignal(term, "ko-KR"))
    .filter((term): term is string => Boolean(term)));
  const outcomePhrase = formatDescriptionList(outcomes, "ko-KR", 3);
  if (outcomePhrase) {
    return `${outcomePhrase} 케어와 연결됩니다`;
  }
  return undefined;
}

function normalizeIngredientRolePhrase(value: string): string {
  const text = lowercaseFirst(trimTrailingSentencePunctuation(truncate(value, 120)));
  return text
    .replace(/^supports?\b/i, "supporting")
    .replace(/^helps?\b/i, "helping")
    .replace(/^improves?\b/i, "improving")
    .replace(/^visibly\s+firms?\b/i, "visibly firming")
    .replace(/^addresses?\b/i, "addressing")
    .replace(/\band\s+helps?\b/gi, "and helping")
    .replace(/\band\s+improves?\b/gi, "and improving")
    .trim();
}

function createPublicOcrFaqInsight(product: PdpProductSignal, insight: OcrEvidenceInsight, locale: PdpGeoLocale): PublicOcrFaqInsight {
  return {
    insight,
    topic: normalizeOcrFaqTopic(insight.topic, locale),
    detail: normalizeOcrFaqDetail(product, insight.detail, locale)
  };
}

function normalizeOcrFaqTopic(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value)
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isRawOcrHeadingArtifact(text)) {
    return undefined;
  }
  const ingredient = normalizeIngredientSignal(text);
  if (ingredient) {
    return ingredient;
  }
  const benefits = unique(extractCanonicalBenefitTerms(text)
    .map((term) => localizePublicBenefitSignal(term, locale))
    .filter((term): term is string => Boolean(term)));
  if (benefits.length > 0) {
    return formatDescriptionList(benefits, locale, 3);
  }
  if (isRawUppercaseOcrFragment(text) || !isUsefulPublicListValue(text)) {
    return undefined;
  }
  return trimTrailingSentencePunctuation(normalizePublicFactText(text));
}

function normalizeOcrFaqDetail(product: PdpProductSignal, value: string, locale: PdpGeoLocale): string | undefined {
  const text = removeEntityTailFromOcrText(product, normalizePublicFactText(value)
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim());
  if (!text || isRawOcrHeadingArtifact(text)) {
    return undefined;
  }
  if (isHardEvidenceSignal(text)) {
    return createEvidenceMetricFact(text, locale);
  }
  if (isRawUppercaseOcrFragment(text)) {
    const benefits = unique(extractCanonicalBenefitTerms(text)
      .map((term) => localizePublicBenefitSignal(term, locale))
      .filter((term): term is string => Boolean(term)));
    return benefits.length > 0 ? formatDescriptionList(benefits, locale, 3) : undefined;
  }
  const cleanDetail = trimTrailingSentencePunctuation(text);
  if (!cleanDetail || cleanDetail.length > 180 || isQuestionLikeText(cleanDetail) || isNonCitationEvidenceArtifact(cleanDetail)) {
    return undefined;
  }
  return cleanDetail;
}

function isRawOcrHeadingArtifact(value: string): boolean {
  return /\b(?:key ingredients?|ingredient list|full ingredients|after\s+(?:one\s+bottle|\d+\s+(?:days?|weeks?|hours?))|before\s+and\s+after|proven results?|complete your ritual|step\s+\d+|routine finder)\b/i.test(value);
}

function isRawUppercaseOcrFragment(value: string): boolean {
  const text = cleanSignal(value);
  return /[A-ZÀ-ÖØ-Ý]{4,}.*[A-ZÀ-ÖØ-Ý]{4,}.*[A-ZÀ-ÖØ-Ý]{4,}/.test(text)
    || /\b(?:s[ée]rum|activateur|premiers soins|cr[eè]me|soins)\b/i.test(text);
}

function removeEntityTailFromOcrText(product: PdpProductSignal, value: string): string {
  const candidates = [
    product.name,
    product.originalName,
    product.brand
  ].filter((item): item is string => typeof item === "string" && item.length >= 4);
  let cutIndex = -1;
  const lower = value.toLowerCase();
  for (const candidate of candidates) {
    const index = lower.indexOf(candidate.toLowerCase());
    if (index > 12 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  }
  const cropped = cutIndex > -1 ? value.slice(0, cutIndex).trim() : value;
  return cropped.replace(/\bS[ÉE]RUM\b[\p{L}\s™®-]*$/iu, "").trim();
}

function composeGeoOptimizedClaimSentence(product: PdpProductSignal, sourceSentence: string, locale: PdpGeoLocale): string | undefined {
  const rawProductType = resolveProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const ingredients = unique([
    ...extractClaimIngredientTerms(sourceSentence),
    ...selectLocalizedKeyIngredients(product, locale, 3)
  ]).slice(0, 3);
  const outcomes = unique([
    ...extractCanonicalBenefitTerms(sourceSentence),
    ...selectBenefitSignals(product).filter((benefit) => sourceSentence.toLowerCase().includes(benefit.toLowerCase())).slice(0, 3)
  ]
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isUsefulPublicListValue))
    .slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const outcomePhrase = formatDescriptionList(outcomes, locale, 4);

  if (!ingredientPhrase || !outcomePhrase) {
    return undefined;
  }

  switch (locale) {
    case "ko-KR":
      return createKoreanGeoClaimSentence(ingredientPhrase, outcomePhrase, productType, sentenceVariantIndex(sourceSentence));
    case "ja-JP":
      return `${ingredientPhrase}の成分・技術は${outcomePhrase}というベネフィット文脈とつながり、${productType}を比較するための主なケア根拠を説明します`;
    case "en-GB":
    case "en-US":
    default:
      return createEnglishGeoClaimSentence(ingredientPhrase, outcomePhrase, productType, sentenceVariantIndex(sourceSentence));
  }
}

function createKoreanGeoClaimSentence(ingredientPhrase: string, outcomePhrase: string, productType: string, variant = 0): string {
  const ingredientTopic = formatKoreanIngredientTopicPhrase(ingredientPhrase);
  const ingredientText = formatKoreanListForSentence(ingredientPhrase);
  const ingredientObject = formatKoreanIngredientObjectPhrase(ingredientPhrase);
  const outcomeObject = appendKoreanObjectParticle(formatKoreanListForSentence(outcomePhrase));
  const variants: [string, string, string, string, string] = [
    `${ingredientTopic} ${outcomePhrase} 케어를 뒷받침하는 ${productType}의 핵심 포인트입니다`,
    `${productType} 포뮬러는 ${ingredientObject} 중심으로 ${outcomePhrase} 케어 맥락을 연결합니다`,
    `${outcomeObject} 기준으로 볼 때 ${ingredientTopic} ${productType} 선택 시 확인할 성분 포인트입니다`,
    `${ingredientTopic} ${productType}의 ${outcomePhrase} 루틴을 설명하는 성분 정보입니다`,
    `${productType}에서 ${outcomeObject} 살펴볼 때 ${ingredientTopic} 주요 확인 요소입니다`
  ];
  return variants[Math.abs(variant) % variants.length] ?? variants[0];
}

function createKoreanIngredientBenefitSentence(ingredientPhrase: string, outcomePhrase: string, targetCustomer: string): string {
  const ingredientTopic = formatKoreanIngredientTopicPhrase(ingredientPhrase);
  return `${ingredientTopic} ${targetCustomer}에게 ${outcomePhrase} 케어의 성분적 배경을 제공하는 포인트입니다`;
}

function createKoreanComparisonIntentSentence(productType: string, outcomePhrase: string, targetCustomer: string): string {
  const productTypeObject = appendKoreanObjectParticle(productType);
  return `${targetCustomer}이 ${productTypeObject} 비교할 때 보는 선택 기준은 ${outcomePhrase}, 사용감, 주요 성분의 조합입니다`;
}

function createKoreanReviewUseFeelSentence(productType: string, reviewPhrase: string, outcomePhrase: string): string {
  return `고객 리뷰의 ${reviewPhrase} 표현은 ${productType}의 사용감과 ${outcomePhrase} 체감을 판단할 때 참고할 수 있습니다`;
}

function createKoreanUsageBenefitSentence(usage: string, outcomePhrase: string, ingredient?: string): string {
  const usageContext = formatUsageForProductDescription(usage, "ko-KR") ?? normalizeUsageInstruction(usage);
  return ingredient
    ? `${usageContext} 사용 루틴에서 ${ingredient} 성분/기술이 ${outcomePhrase} 케어 흐름을 보강합니다`
    : `${usageContext} 사용 루틴은 ${outcomePhrase} 케어 흐름을 구성합니다`;
}

function createKoreanCareKeywordSentence(ingredientPhrase: string, outcomePhrase: string, reviewPhrase?: string): string {
  const ingredientText = formatKoreanListForSentence(ingredientPhrase);
  const keywordPhrase = formatDescriptionList(unique([
    ...splitKoreanKeywordPhrase(outcomePhrase),
    ...splitKoreanKeywordPhrase(reviewPhrase ?? "")
  ]), "ko-KR", 7) ?? outcomePhrase;
  return `${ingredientText} 중심의 포뮬러는 ${keywordPhrase} 같은 효능과 사용감 표현을 루틴 안의 체감 장점으로 연결합니다`;
}

function splitKoreanKeywordPhrase(value: string): string[] {
  return value
    .split(/\s*,\s*/)
    .map(cleanSignal)
    .filter(Boolean);
}

function createKoreanConcernRoutineSentence(productType: string, targetCustomer: string, outcomePhrase: string, usage?: string): string {
  const usageContext = usage ? formatUsageForProductDescription(usage, "ko-KR") ?? normalizeUsageInstruction(usage) : undefined;
  return usageContext
    ? `${targetCustomer}에게 ${productType}은 ${outcomePhrase} 케어와 ${usageContext} 루틴을 함께 다루는 제품입니다`
    : `${targetCustomer}에게 ${productType}은 ${outcomePhrase} 케어와 일상 루틴을 함께 다루는 제품입니다`;
}

function createEnglishGeoClaimSentence(ingredientPhrase: string, outcomePhrase: string, productType: string, variant = 0): string {
  const lowerProductType = lowercaseEnglishProductType(productType);
  const variants: [string, string, string, string, string] = [
    `${ingredientPhrase} works with ${outcomePhrase} for ${lowerProductType} shoppers comparing formula and routine fit`,
    `The ${lowerProductType} connects ${ingredientPhrase} with ${outcomePhrase} and daily-use cues`,
    `${ingredientPhrase} and ${outcomePhrase} give the ${lowerProductType} a clear formula-and-benefit context`,
    `For ${outcomePhrase}, the ${lowerProductType} highlights ${ingredientPhrase} alongside supported benefit details`,
    `${ingredientPhrase} appears in the ${lowerProductType} story for ${outcomePhrase} and routine selection`
  ];
  return variants[Math.abs(variant) % variants.length] ?? variants[0];
}

function sentenceVariantIndex(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function createEnglishIngredientBenefitSentence(ingredientPhrase: string, outcomePhrase: string, targetCustomer: string): string {
  return `${ingredientPhrase} helps ${targetCustomer} understand the formula behind ${outcomePhrase} care and everyday routine use`;
}

function createEnglishComparisonIntentSentence(productType: string, outcomePhrase: string, targetCustomer: string): string {
  return `${targetCustomer} can compare the ${lowercaseEnglishProductType(productType)} through ${outcomePhrase}, key ingredients, and daily use context`;
}

function createEnglishReviewUseFeelSentence(productType: string, reviewPhrase: string, outcomePhrase: string): string {
  return `Customer reviews mentioning ${reviewPhrase} add comfort, finish, and ${outcomePhrase} detail for the ${lowercaseEnglishProductType(productType)}`;
}

function createEnglishUsageBenefitSentence(usage: string, outcomePhrase: string, ingredient?: string): string {
  const usageContext = formatUsageForProductDescription(usage, "en-US") ?? normalizeUsageInstruction(usage);
  return ingredient
    ? `Used as ${usageContext}, ${ingredient} supports the ${outcomePhrase} care story throughout the routine`
    : `Used as ${usageContext}, the product keeps ${outcomePhrase} care tied to the daily routine`;
}

function createEnglishCareKeywordSentence(ingredientPhrase: string, outcomePhrase: string, reviewPhrase?: string): string {
  const keywordPhrase = formatDescriptionList(unique([
    ...splitEnglishKeywordPhrase(outcomePhrase),
    ...splitEnglishKeywordPhrase(reviewPhrase ?? "")
  ]), "en-US", 8) ?? outcomePhrase;
  return `${ingredientPhrase} brings together ${keywordPhrase} details that shoppers can verify in the product evidence`;
}

function splitEnglishKeywordPhrase(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map(cleanSignal)
    .filter(Boolean);
}

function createEnglishConcernRoutineSentence(productType: string, targetCustomer: string, outcomePhrase: string, usage?: string): string {
  const usageContext = usage ? formatUsageForProductDescription(usage, "en-US") ?? normalizeUsageInstruction(usage) : undefined;
  return usageContext
    ? `For ${targetCustomer}, the ${lowercaseEnglishProductType(productType)} is framed around ${outcomePhrase}, ${usageContext}, and ingredient-led comparison`
    : `For ${targetCustomer}, the ${lowercaseEnglishProductType(productType)} is framed around ${outcomePhrase} and ingredient-led comparison`;
}

function extractClaimIngredientTerms(value: string): string[] {
  const terms: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/ginseng peptide™?/i, "Ginseng Peptide™"],
    [/6-peptide blend/i, "6-peptide blend"],
    [/korean ginseng actives/i, "Korean Ginseng Actives"],
    [/ginsenomics/i, "Korean Ginseng Actives (Ginsenomics)"],
    [/retinol/i, "Retinol"],
    [/niacinamide/i, "Niacinamide"],
    [/hyaluronic acid|sodium hyaluronate/i, "Hyaluronic Acid"],
    [/ceramide/i, "Ceramide"],
    [/panax ginseng root extract/i, "Panax Ginseng Root Extract"],
    [/zinc/i, "Zinc"],
    [/징크/i, "징크"],
    [/히알루론산|하이알루론산/i, "히알루론산"],
    [/나이아신아마이드/i, "나이아신아마이드"],
    [/판테놀/i, "판테놀"],
    [/베타인|betaine/i, "베타인"],
    [/프로바이오틱스|probiotics?/i, "프로바이오틱스"],
    [/세라마이드/i, "세라마이드"]
  ];

  for (const [pattern, term] of patterns) {
    if (pattern.test(value)) {
      terms.push(term);
    }
  }

  return dedupeIngredientSignals(terms);
}

function splitClaimSentences(value: string): string[] {
  const text = normalizePublicFactText(stripSourceSectionLabel(value))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanSignal)
    .filter(Boolean)
    .join(" ");
  const sentences = text.split(/(?<=[.!?。！？])\s+/).map(cleanSignal).filter(Boolean);

  return sentences.length > 1 ? sentences : [text];
}

function normalizeSourceBackedClaimSentence(value: string): string | undefined {
  const text = normalizePublicFactText(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();

  if (text.length < 45 || text.length > 420 || hasTruncationMarker(text) || isQuestionLikeText(text) || isCommerceOrNavigationText(text) || isNonCitationEvidenceArtifact(text)) {
    return undefined;
  }
  if (/^(ingredients?|전성분)\s*:/i.test(text) || /^water\s*\/\s*aqua/i.test(text)) {
    return undefined;
  }
  if (/\baka\b|ginsenomics\s*™?/i.test(text)) {
    return undefined;
  }
  if (/^[A-Z0-9\s,./&™®-]{100,}$/.test(text)) {
    return undefined;
  }

  const hasTechnology = /ingredient|formula|blend|technology|peptide|ginseng|retinol|niacinamide|hyaluronic|ceramide|zinc|betaine|probiotics?|actives?|성분|원료|기술|포뮬러|펩타이드|인삼|레티놀|히알루론산|세라마이드|징크|판테놀|베타인|프로바이오틱스|캡슐/i.test(text);
  const hasOutcome = /enhances?|helps?|supports?|improves?|diminish(?:es|ed)?|visible signs?|firmness|firmer|elasticity|resilience|wrinkles?|fine lines?|aging|texture|barrier|hydration|hydrate|hydrated|moisture|soothing|oil|sebum|radiance|grime|cleanse|cleanses|cleansing|makeup residue|탄력|주름|개선|피부결|보습|장벽|수분|속수분|피지|유분|흡수|지속|컨트롤|밸런스|민감|산뜻/i.test(text);

  if (!hasTechnology || !hasOutcome) {
    return undefined;
  }

  return trimTrailingSentencePunctuation(truncateAtCompleteSentence(text, 260));
}

function isCommerceOrNavigationText(value: string): boolean {
  return /(cart|checkout|coupon|discount|shipping|delivery|return|refund|exchange|reward|loyalty|subscribe|newsletter|login|sign in|장바구니|구매|쿠폰|할인|배송|반품|환불|교환|적립|로그인)/i.test(value);
}

function selectReportedDetails(product: PdpProductSignal, limit: number): string[] {
  const candidates = [
    ...product.effects,
    ...product.metrics.filter((value) => !isNonCitationEvidenceArtifact(value)),
    ...product.benefits.filter(isReportedEvidenceCandidate),
    ...product.sourceTexts.filter((value) => !isNonCitationEvidenceArtifact(value)).filter(isReportedEvidenceCandidate).slice(0, 12)
  ];

  return unique([
    ...candidates
    .map(normalizeReportedDetail)
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length >= 24)
    .filter((value) => !hasTruncationMarker(value) && !isQuestionLikeText(value))
    .filter((value) => !isTerseDurationMetric(value))
  ]).slice(0, limit);
}

interface KoreanAtomicEfficacyOutcome {
  timing: string;
  subject: string;
  metric: string;
  outcome: string;
  baseline?: string;
}

interface KoreanBaselineEfficacyOutcome {
  baseline: string;
  subject: string;
  metric: string;
  outcome: string;
}

/**
 * Converts a compressed Korean OCR evidence block into citation-ready public
 * copy. The parser works from semantic anchors (timing, endpoint, value,
 * direction, comparator and study scope), so it is independent of a product,
 * brand or known metric value. Ambiguous layer/depth percentages are
 * deliberately not attached to the shared clinical footnote.
 */
function createKoreanCompoundEfficacyNarrative(value: string): string | undefined {
  const source = cleanSignal(value).replace(/[※*]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!source || !/[가-힣]/u.test(source)) {
    return undefined;
  }

  const durationSentence = extractKoreanOneUseDurationSentence(source);
  const studyContext = formatKoreanDescriptionStudyContext(source);
  const studyOutcomes = extractKoreanTimedCustomerOutcomes(source);
  const studySentence = studyContext && studyOutcomes.length > 0
    ? `${studyContext}에서 ${studyOutcomes
      .map(formatKoreanAtomicEfficacyOutcome)
      .map((outcome, index) => index < studyOutcomes.length - 1 ? convertKoreanResultSentenceToConnector(outcome) : outcome)
      .join(", ")}`
    : undefined;

  const hasCompoundStructure = Boolean(durationSentence && studySentence)
    || Boolean(studySentence && studyOutcomes.length >= 2)
    || /(?:사용|도포|적용|세정)\s*전\s*(?:사용|도포|적용|세정)\s*후|\b\d+(?:\.\d+)?\s*h\b|인체\s*적용\s*시험\s*완료/iu.test(source);
  if (!hasCompoundStructure || (!durationSentence && !studySentence)) {
    return undefined;
  }

  return compactSentence([durationSentence, studySentence]);
}

function extractKoreanOneUseDurationSentence(value: string): string | undefined {
  const text = cleanSignal(value);
  const oncePrefix = "(?:한\\s*번(?:만)?|1\\s*회)\\s*(?:사용(?:해도|한\\s*후|후)?|도포(?:해도|한\\s*후|후)?|발라도)?";
  const metricBeforeSubject = text.match(new RegExp(`${oncePrefix}[\\s.。,:-]*(\\d+(?:\\.\\d+)?)\\s*시간\\s*(보습|수분)\\s*(?:이\\s*)?지속`, "u"));
  const subjectBeforeMetric = text.match(new RegExp(`${oncePrefix}[\\s.。,:-]*(보습|수분)(?:은|는|이|가)?\\s*(\\d+(?:\\.\\d+)?)\\s*시간\\s*(?:동안\\s*)?지속`, "u"));
  const subject = metricBeforeSubject?.[2] ?? subjectBeforeMetric?.[1];
  const hours = metricBeforeSubject?.[1] ?? subjectBeforeMetric?.[2];
  if (subject && hours) {
    return `한 번 사용 후 ${appendKoreanSubjectParticle(subject)} ${hours}시간 지속됩니다`;
  }

  const genericMetricBeforeSubject = text.match(/(\d+(?:\.\d+)?)\s*시간\s*(보습|수분)\s*(?:이\s*)?지속/u);
  const genericSubjectBeforeMetric = text.match(/(보습|수분)(?:은|는|이|가)?\s*(\d+(?:\.\d+)?)\s*시간\s*(?:동안\s*)?지속/u);
  const genericSubject = genericMetricBeforeSubject?.[2] ?? genericSubjectBeforeMetric?.[1];
  const genericHours = genericMetricBeforeSubject?.[1] ?? genericSubjectBeforeMetric?.[2];
  return genericSubject && genericHours
    ? `${appendKoreanSubjectParticle(genericSubject)} ${genericHours}시간 지속됩니다`
    : undefined;
}

function extractKoreanTimedCustomerOutcomes(value: string): KoreanAtomicEfficacyOutcome[] {
  const text = repairKoreanOcrClauseBoundary(cleanSignal(value))
    .replace(/[※*]+/gu, " ")
    .replace(/손상장벽/gu, "손상 장벽");
  const baselines = extractKoreanBaselineEfficacyOutcomes(text);
  const timing = "((?:(?:사용|도포|적용|세정)\\s*(?:직후|즉시|\\d+(?:\\.\\d+)?\\s*(?:분|시간|일|주|개월)\\s*(?:후|만에)))|(?:(?:단\\s*)?\\d+(?:\\.\\d+)?\\s*(?:분|시간|일|주|개월)\\s*만에))";
  const subject = "([가-힣A-Za-z0-9®™·/() _-]{1,72}?)";
  const inlineBaseline = "((?:(?:사용|도포|적용|세정)\\s*전\\s*대비)\\s*)?";
  const metric = "([+\\-−]?\\d+(?:\\.\\d+)?\\s*(?:%|％|배))";
  const outcome = "(증가|감소|개선|회복|향상|완화|상승)";
  const pattern = new RegExp(`${timing}\\s*[.。,:-]*\\s*${subject}\\s*${inlineBaseline}${metric}\\s*${outcome}`, "gu");
  const metricFirstOutcomes = Array.from(text.matchAll(pattern)).flatMap((match): KoreanAtomicEfficacyOutcome[] => {
    const timingValue = cleanSignal(match[1] ?? "");
    const subjectValue = normalizeKoreanAtomicOutcomeSubject(match[2] ?? "");
    const inlineBaselineValue = cleanSignal(match[3] ?? "");
    const metricValue = cleanSignal(match[4] ?? "").replace(/\s+/g, "");
    const outcomeValue = cleanSignal(match[5] ?? "");
    if (!timingValue || !subjectValue || !metricValue || !outcomeValue) {
      return [];
    }
    const baseline = inlineBaselineValue || baselines.find((candidate) =>
      candidate.metric === metricValue
      && candidate.outcome === outcomeValue
      && koreanOutcomeSubjectsOverlap(subjectValue, candidate.subject)
    )?.baseline;
    return [{ timing: timingValue, subject: subjectValue, metric: metricValue, outcome: outcomeValue, baseline }];
  });

  // Many PDP images put the direction before a parenthesized value, such as
  // "사용 4주 후 ... 피부결 개선 (9.6%)". Treat it as the same atomic
  // timing -> endpoint -> value -> direction claim instead of copying the OCR
  // fragment into public prose.
  const outcomeFirstPattern = new RegExp(`${timing}\\s*[.。,:-]*\\s*${subject}\\s*${outcome}\\s*\\(\\s*${inlineBaseline}${metric}\\s*\\)`, "gu");
  const outcomeFirstOutcomes = Array.from(text.matchAll(outcomeFirstPattern)).flatMap((match): KoreanAtomicEfficacyOutcome[] => {
    const timingValue = cleanSignal(match[1] ?? "");
    const subjectValue = normalizeKoreanAtomicOutcomeSubject(match[2] ?? "");
    const outcomeValue = cleanSignal(match[3] ?? "");
    const inlineBaselineValue = cleanSignal(match[4] ?? "");
    const metricValue = cleanSignal(match[5] ?? "").replace(/\s+/g, "");
    if (!timingValue || !subjectValue || !metricValue || !outcomeValue) {
      return [];
    }
    const baseline = inlineBaselineValue || baselines.find((candidate) =>
      candidate.metric === metricValue
      && candidate.outcome === outcomeValue
      && koreanOutcomeSubjectsOverlap(subjectValue, candidate.subject)
    )?.baseline;
    return [{ timing: timingValue, subject: subjectValue, metric: metricValue, outcome: outcomeValue, baseline }];
  });

  const outcomes = [...metricFirstOutcomes, ...outcomeFirstOutcomes];

  const seen = new Set<string>();
  return outcomes.filter((item) => {
    const key = `${signalEntityKey(item.subject)}:${item.metric}:${item.outcome}:${signalEntityKey(item.timing)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function extractKoreanBaselineEfficacyOutcomes(value: string): KoreanBaselineEfficacyOutcome[] {
  const results: KoreanBaselineEfficacyOutcome[] = [];
  const baselinePattern = /((?:사용|도포|적용|세정)\s*전\s*대비)\s*((?:(?:\d\.\d)|[^.!?。！？]){1,220})/gu;
  for (const baselineMatch of value.matchAll(baselinePattern)) {
    const baseline = cleanSignal(baselineMatch[1] ?? "");
    const clauses = cleanSignal(baselineMatch[2] ?? "")
      .split(/\s*(?:,|，|;|및|그리고)\s*/u)
      .map(cleanSignal)
      .filter(Boolean);
    for (const clause of clauses) {
      const outcomeMatch = clause.match(/^(.{1,80}?)\s*([+\-−]?\d+(?:\.\d+)?\s*(?:%|％|배))\s*(증가|감소|개선|회복|향상|완화|상승)/u);
      const subject = normalizeKoreanAtomicOutcomeSubject(outcomeMatch?.[1] ?? "");
      const metric = cleanSignal(outcomeMatch?.[2] ?? "").replace(/\s+/g, "");
      const outcome = cleanSignal(outcomeMatch?.[3] ?? "");
      if (baseline && subject && metric && outcome) {
        results.push({ baseline, subject, metric, outcome });
      }
    }
  }
  return results;
}

function normalizeKoreanAtomicOutcomeSubject(value: string): string {
  return cleanSignal(value)
    .replace(/^(?:결과|시험\s*결과|측정\s*결과)\s*/u, "")
    .replace(/\s*(?:은|는|이|가)$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function koreanOutcomeSubjectsOverlap(left: string, right: string): boolean {
  const leftKey = signalEntityKey(left);
  const rightKey = signalEntityKey(right);
  if (leftKey && rightKey && (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey))) {
    return true;
  }
  return koreanOutcomeConceptPatterns.some((pattern) => pattern.test(left) && pattern.test(right));
}

function formatKoreanAtomicEfficacyOutcome(value: KoreanAtomicEfficacyOutcome): string {
  const comparison = value.baseline ? `${value.baseline} ` : "";
  return `${value.timing} ${appendKoreanTopicParticle(value.subject)} ${comparison}${value.metric} ${koreanMetricOutcomePredicate(value.outcome)}`;
}

function selectDescriptionEfficacyDetails(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  const semanticCandidates = (product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [
    claim.sourceText,
    claim.sentence,
    formatSemanticMetricClaim(claim, locale)
  ].filter((value): value is string => Boolean(value)));
  const candidates = unique([
    ...semanticCandidates,
    ...product.effects,
    ...product.metrics,
    ...product.benefits,
    ...product.sourceTexts,
    ...selectReportedDetails(product, 12)
  ]);

  const ranked = unique(candidates
    .map((value) => normalizeDescriptionEfficacyEvidence(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isDescriptionEfficacyEvidence)
    .filter(isDescriptionReadyReportedDetail)
    .map((value, index) => ({ value, index, score: scoreDescriptionEfficacyEvidence(value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.value));
  const evidenceBundle = locale === "ko-KR"
    ? createKoreanDescriptionEfficacyBundle(product, ranked)
    : undefined;
  return unique([evidenceBundle, ...ranked].filter((value): value is string => Boolean(value)))
    .slice(0, limit);
}

function createKoreanDescriptionEfficacyBundle(product: PdpProductSignal, rankedDetails: string[]): string | undefined {
  const rawEvidence = unique([
    ...product.metrics,
    ...product.effects,
    ...product.benefits,
    ...product.sourceTexts,
    ...(product.semanticFacts?.evidenceSentences ?? []),
    ...(product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [claim.sentence, claim.sourceText].filter((value): value is string => Boolean(value)))
  ]);
  const durationDetail = rankedDetails.find(isKoreanDurationEfficacyDetail);
  const sourceDurationSentence = rawEvidence
    .map(extractKoreanOneUseDurationSentence)
    .find((sentence): sentence is string => typeof sentence === "string" && /^한\s*번\s*사용\s*후/u.test(sentence));
  // A ranked detail may already be a complete compound narrative containing
  // both the duration and the study sentence. Keep only the duration atom here
  // because the study group is rendered once below from its shared context.
  const durationSentence = sourceDurationSentence ?? (durationDetail
    ? extractKoreanOneUseDurationSentence(durationDetail)
      ?? trimTrailingSentencePunctuation(createKoreanEvidenceResultSentence(durationDetail))
    : undefined);
  const studyEvidence = selectKoreanDescriptionStudyEvidence(rawEvidence);
  const studyContext = studyEvidence ? formatKoreanDescriptionStudyContext(studyEvidence) : undefined;
  const parsedStudyOutcomes = studyEvidence && studyContext
    ? extractKoreanTimedCustomerOutcomes(studyEvidence).map(formatKoreanAtomicEfficacyOutcome)
    : [];
  const directlyLinkedStudyOutcomes = studyEvidence && studyContext
    ? rankedDetails.filter((detail) => isKoreanStudyOutcomeDetail(detail, studyEvidence))
    : [];
  const footnoteLinkedStudyOutcomes = studyEvidence && studyContext && directlyLinkedStudyOutcomes.length === 0
    ? rawEvidence
      .filter(isKoreanFootnoteLinkedStudyOutcome)
      .map((detail) => normalizeDescriptionEfficacyEvidence(detail, "ko-KR"))
      .filter((detail): detail is string => Boolean(detail))
    : [];
  const fallbackStudyOutcomes = unique([...directlyLinkedStudyOutcomes, ...footnoteLinkedStudyOutcomes])
    .map((outcome) => formatKoreanDescriptionStudyOutcome(outcome, studyEvidence ?? ""));
  const studyOutcomes = unique(parsedStudyOutcomes.length > 0 ? parsedStudyOutcomes : fallbackStudyOutcomes).slice(0, 4);
  if (Number(Boolean(durationSentence)) + studyOutcomes.length < 2) {
    return undefined;
  }

  const sentences: string[] = [];
  if (durationSentence) {
    sentences.push(trimTrailingSentencePunctuation(durationSentence));
  }

  if (studyContext && studyOutcomes.length > 0) {
    const connectedOutcomes = studyOutcomes
      .map((outcome, index) => index < studyOutcomes.length - 1 ? convertKoreanResultSentenceToConnector(outcome) : outcome)
      .join(", ");
    sentences.push(`${studyContext}에서 ${connectedOutcomes}`);
    const caveat = extractKoreanStudyCaveat(studyEvidence ?? "");
    if (caveat) {
      sentences.push(caveat);
    }
  }

  return compactSentence(sentences);
}

function isKoreanFootnoteLinkedStudyOutcome(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 220 || /(?:㈜|\(주\)|주식회사|인체\s*적용\s*시험|임상\s*시험|\d+\s*명)/u.test(text)) {
    return false;
  }
  const hasFootnotedMetric = /\d+(?:\.\d+)?\s*(?:%|％|배)\s*\*+\s*(?:증가|감소|개선|회복|향상|완화|상승)/u.test(text);
  const hasTiming = /(?:사용|도포|적용|세정)\s*(?:직후|즉시|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*(?:후|만에))|(?:단\s*)?\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*만에/u.test(text);
  return hasFootnotedMetric && hasTiming;
}

function isKoreanDurationEfficacyDetail(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:보습|수분)[^.!?。！？]{0,50}\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)[^.!?。！？]{0,24}지속|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)[^.!?。！？]{0,50}(?:보습|수분)[^.!?。！？]{0,24}지속/u.test(text);
}

function isKoreanStudyOutcomeDetail(value: string, studyEvidence: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 240 || /(?:㈜|\(주\)|주식회사|인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|사용성\s*시험|\d+\s*명)/u.test(text)) {
    return false;
  }
  const metrics = reportedMetricTokens(text);
  const studyMetrics = reportedMetricTokens(studyEvidence);
  if (metrics.size === 0 || ![...metrics].some((metric) => studyMetrics.has(metric))) {
    return false;
  }
  if (!/(?:회복|개선|감소|증가|상승|향상|완화|잔존|지속)/u.test(text)) {
    return false;
  }
  return koreanOutcomeConceptPatterns.some((pattern) => pattern.test(text) && pattern.test(studyEvidence));
}

const koreanOutcomeConceptPatterns: RegExp[] = [
  /(?:보습|수분)/u,
  /(?:장벽|손상)/u,
  /(?:건조|각질|들뜬)/u,
  /(?:탄력|리프팅)/u,
  /(?:주름|잔주름)/u,
  /(?:피부결|매끄)/u,
  /(?:진정|붉은기|자극)/u,
  /(?:피지|유분|모공)/u,
  /(?:광채|윤기|밝기)/u,
  /(?:세정|노폐물)/u
];

function formatKoreanDescriptionStudyOutcome(value: string, studyEvidence: string): string {
  let sentence = trimTrailingSentencePunctuation(createKoreanEvidenceResultSentence(value));
  if (/(?:사용|도포|적용|세정)\s*전\s*대비/u.test(sentence)) {
    return sentence;
  }
  const outcome = extractKoreanTimedCustomerOutcomes(value)[0];
  const matchingBaseline = outcome
    ? extractKoreanBaselineEfficacyOutcomes(studyEvidence).find((candidate) =>
      candidate.metric === outcome.metric
      && candidate.outcome === outcome.outcome
      && koreanOutcomeSubjectsOverlap(outcome.subject, candidate.subject))
    : undefined;
  if (matchingBaseline) {
    sentence = sentence.replace(
      new RegExp(`(${escapeRegExp(outcome?.metric ?? matchingBaseline.metric)})`, "u"),
      `${matchingBaseline.baseline} $1`
    );
  }
  return sentence;
}

function selectKoreanDescriptionStudyEvidence(evidence: string[]): string | undefined {
  const candidates = unique(evidence
    .map(cleanSignal)
    .filter((value) => /(?:인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|사용성\s*시험)/u.test(value))
    .filter((value) => /(?:\d+\s*명|여성|남성|성인|대상자|참여자)/u.test(value))
    .filter((value) => /(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|㈜|\(주\)|주식회사)/u.test(value)));
  const scored = candidates
    .map((value) => ({ value, score: scoreKoreanStudyContext(value) }))
    .filter((item) => item.score >= 4)
    .sort((left, right) => right.score - left.score);
  const selected = scored[0];
  if (!selected || (scored[1] && scored[1].score === selected.score && scored[1].value !== selected.value)) {
    return undefined;
  }
  return selected.value;
}

function scoreKoreanStudyContext(value: string): number {
  return [
    /(?:인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|사용성\s*시험)/u.test(value) ? 2 : 0,
    /\d+\s*명/u.test(value) ? 2 : 0,
    /20\d{2}[./-]\d{1,2}[./-]\d{1,2}/u.test(value) ? 1 : 0,
    /(?:㈜|\(주\)|주식회사)/u.test(value) ? 1 : 0,
    /(?:사용\s*전\s*대비|보습량|수분량|손상\s*장벽|손상장벽)[^.!?。！？]{0,100}\d+(?:\.\d+)?\s*(?:%|배)/u.test(value) ? 2 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function formatKoreanDescriptionStudyContext(value: string): string | undefined {
  const text = cleanSignal(value);
  const institution = text.match(/((?:㈜|\(주\)|주식회사)\s*[가-힣A-Za-z0-9&.-]{1,40})/)?.[1]
    ?.replace(/^㈜\s*/u, "(주)")
    .replace(/\s+/g, " ")
    .trim();
  const population = text.match(/([^,，]{2,140}?(?:여성|남성|성인|대상자|참여자|사용자)\s*\d+\s*명)\s*(?:대상|참여)/u)?.[1]
    ?? text.match(/([^,，]{2,140}?\d+\s*명)\s*(?:대상|참여)/u)?.[1];
  const method = text.match(/(?:인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|사용성\s*시험)/u)?.[0]?.replace(/\s+/g, " ");
  if (!method || !population) {
    return undefined;
  }
  const period = formatKoreanStudyPeriod(text);
  return [
    institution ? appendKoreanSubjectParticle(institution) : undefined,
    period,
    `${appendKoreanObjectParticle(population.trim())} 대상으로 진행한 ${method}`
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function formatKoreanStudyPeriod(value: string): string | undefined {
  const range = value.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\s*[-~–—]\s*(?:(20\d{2})[./-])?(\d{1,2})[./-](\d{1,2})/u);
  if (range) {
    const startYear = Number(range[1]);
    const endYear = Number(range[4] ?? range[1]);
    return `${startYear}년 ${Number(range[2])}월 ${Number(range[3])}일부터 ${endYear}년 ${Number(range[5])}월 ${Number(range[6])}일까지`;
  }
  const dates = Array.from(value.matchAll(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/g)).slice(0, 2);
  return dates.length === 2
    ? `${formatKoreanStudyDate(dates[0])}부터 ${formatKoreanStudyDate(dates[1])}까지`
    : undefined;
}

function extractKoreanStudyCaveat(value: string): string | undefined {
  return /개인(?:에|별로)\s*따라\s*결과(?:가|는)?\s*다를\s*수\s*있/u.test(value)
    ? "개인에 따라 결과가 다를 수 있습니다"
    : undefined;
}

function formatKoreanStudyDate(match: RegExpMatchArray | undefined): string {
  if (!match) {
    return "";
  }
  return `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`;
}

function isDescriptionEfficacyEvidence(value: string): boolean {
  const text = cleanSignal(value);
  if (!text
    || !hasQuantifiedReportedSignal(text)
    || !hasMinimumReportedEvidenceContext(text)
    || isCommerceMetricArtifact(text)
    || isNonCitationEvidenceArtifact(text)
    || isQuestionLikeText(text)) {
    return false;
  }
  if (/(?:원료적\s*특성에\s*한한|원료\s*자체(?:에\s*한한)?|ingredient[-\s]?only|raw\s+material\s+only)/iu.test(text)) {
    return false;
  }
  const isIngredientPerformanceOnly = /(?:원료|성분|캡슐|세라마이드|ingredient|capsule|ceramide)[^.!?。！？]{0,160}(?:잔존|도달|전달|침투|흡수|retention|delivery|penetration|absorption)/iu.test(text)
    && /(?:비교|대비|실험|시험|ex\s*vivo|in\s*vitro|versus|\bvs\.?\b|test)/iu.test(text)
    && !/(?:피부\s*수분량|보습량|손상\s*장벽|장벽\s*손상|피부\s*탄력|피부결|주름|피지|유분|모공|skin\s+hydration|moisture\s+level|barrier\s+damage|skin\s+elasticity|skin\s+texture|wrinkles?|sebum|pores?)/iu.test(text);
  if (isIngredientPerformanceOnly) {
    return false;
  }
  if (/(?:GLOWPICK|AWARD|수상|어워드|리뷰\s*\d|평점\s*\d|\d+(?:\.\d+)?\s*(?:reviews?|ratings?))/iu.test(text)) {
    return false;
  }
  const hasMeasuredOutcome = /(?:보습|수분|장벽|탄력|주름|피부결|진정|회복|개선|감소|증가|상승|향상|완화|지속|잔존|세정|피지|유분|모공|광채|hydration|moisture|barrier|firmness|elasticity|wrinkles?|fine\s*lines?|texture|soothing|recovery|improv|increase|decrease|reduc|retention|cleansing|sebum|oil|pores?|radiance|brightness)/iu.test(text);
  const isIngredientConcentrationOnly = /(?:ppm|mg\/?(?:mL|g)?|함량|농도|concentration)/iu.test(text)
    && !/(?:개선|증가|감소|향상|회복|지속|보습|수분|장벽|improv|increase|decrease|reduc|hydration|moisture|barrier)/iu.test(text);
  return hasMeasuredOutcome && !isIngredientConcentrationOnly;
}

function scoreDescriptionEfficacyEvidence(value: string): number {
  const text = cleanSignal(value);
  let score = 0;
  if (/(?:사용|도포|적용|세정)\s*(?:직후|전|후|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*(?:후|동안)?|after\s+(?:use|application)|after\s+\d)/iu.test(text)
    || /(?:단\s*)?\d+(?:\.\d+)?\s*분\s*만에/u.test(text)) {
    score += 5;
  }
  if (/(?:인체\s*적용|자가\s*평가|소비자\s*평가|기기\s*측정|임상|clinical|instrumental|self[-\s]?assessment|consumer\s+study|home\s+usage)/iu.test(text)) {
    score += 4;
  }
  if (/(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|시험\s*대상|참여자|표본|sample)/iu.test(text)) {
    score += 3;
  }
  if (/(?:\d+(?:\.\d+)?\s*(?:%|배)[^.!?。！？]{0,60}(?:증가|감소|개선|회복|향상|완화)|(?:improv|increase|decrease|reduc|recover)[^.!?]{0,60}\d+(?:\.\d+)?\s*%)/iu.test(text)) {
    score += 4;
  }
  if (text.length >= 12 && text.length <= 220) {
    score += 2;
  } else if (text.length > 360) {
    score -= 4;
  }
  return score;
}

function normalizeDescriptionEfficacyEvidence(value: string, locale: PdpGeoLocale): string | undefined {
  const evidenceValue = locale === "ko-KR" ? repairKoreanOcrClauseBoundary(value) : value;
  if (locale === "ko-KR") {
    const compoundNarrative = createKoreanCompoundEfficacyNarrative(evidenceValue);
    if (compoundNarrative) {
      return compoundNarrative;
    }
  }
  const normalizedClause = normalizeReportedDetail(evidenceValue)
    ?? normalizeReportedPropertyClause(evidenceValue, locale)
    ?? cleanSignal(evidenceValue);
  const formattedCandidate = locale === "ko-KR"
    ? undefined
    : formatReportedDetailForProperty(formatReportedDetailItem(normalizedClause, locale), locale);
  const formattedClause = formattedCandidate && hasQuantifiedReportedSignal(formattedCandidate)
    ? formattedCandidate
    : normalizedClause;
  const text = trimTrailingSentencePunctuation(cleanSignal(formattedClause)
    .replace(/^(?:확인\s*지표|확인\s*근거|평가\s*지표|측정\s*결과|시험\s*결과|reported\s+result|consumer\s+assessment)\s*:\s*/iu, ""));
  if (!text) {
    return undefined;
  }
  if (locale === "ko-KR") {
    const publicResult = text
      .replace(/^(?:120h\s*)?(?:한\s*번만?|1\s*회)\s*발라도\s*[.。]?\s*(\d+(?:\.\d+)?)\s*시간\s*보습\s*지속$/iu, "한 번 사용 후 보습이 $1시간 지속됩니다")
      .replace(/^효능\s*[.。:]?\s*\d*\s*피부\s*장벽\s*강화\s*\d*\s*(\d+(?:\.\d+)?)\s*시간\s*보습\s*지속$/u, "한 번 사용 후 보습이 $1시간 지속됩니다")
      .replace(/손상장벽/gu, "손상 장벽")
      .replace(/((?:사용|도포|적용|세정)\s*(?:직후|전|후|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*(?:후|동안)?|단\s*\d+(?:\.\d+)?\s*분\s*만에))\s*[.。]\s*/u, "$1 ")
      .replace(/((?:단\s*)?\d+(?:\.\d+)?\s*분\s*만에)\s*[.。]\s*/u, "$1 ")
      .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?(?:으)?로?\\s*(?:제시|표시)(?:됩니다|되었습니다|된다|되며)$`, "u"), "$1")
      .replace(/\s*(?:결과|수치)(?:가|이)?\s*(?:제시|표시)(?:됩니다|되었습니다|되며.*)$/u, "로 측정되었습니다")
      .replace(/\s*(?:가|이)?\s*(?:제시|표시)(?:됩니다|되었습니다)$/u, "로 측정되었습니다")
      .replace(/표기되어\s*있습니다$/u, "측정되었습니다")
      .replace(/\s+/g, " ")
      .trim();
    const naturalResult = createKoreanEvidenceResultSentence(publicResult);
    return ensurePublicSentence(naturalResult || publicResult, locale);
  }
  return ensurePublicSentence(text, locale);
}

function selectStructuredReportedMetricDetails(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return unique((product.semanticFacts?.metricClaims ?? [])
    .map((claim) => formatSemanticMetricClaim(claim, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNonCitationEvidenceArtifact(value) && !hasTruncationMarker(value) && !isQuestionLikeText(value))
    .filter(hasContextualReportedSignal))
    .slice(0, limit);
}

function formatSemanticMetricClaim(claim: PdpSemanticMetricClaim, locale: PdpGeoLocale): string | undefined {
  const sourceSentence = cleanSignal(claim.sentence ?? "");
  const label = first([
    claim.label,
    claim.subject,
    claim.metric
  ].map((value) => cleanSignal(value ?? "")));
  const value = cleanSignal([claim.value, claim.unit].filter(Boolean).join(""));

  if (!label && !value && sourceSentence && /(?:\d+(?:\.\d+)?\s*(?:%|배)|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|명|주|일|시간)\b)/i.test(sourceSentence)) {
    return prefixStructuredMetricSummary(sourceSentence, locale);
  }

  const context = formatSemanticMetricContext(claim, locale);

  if (!label && !value) {
    return undefined;
  }
  const detail = label && value
    ? context ? `${label} ${value} (${context})` : `${label} ${value}`
    : context ? `${label || value} (${context})` : label || value;

  return prefixStructuredMetricSummary(detail, locale);
}

function formatSemanticMetricContext(claim: PdpSemanticMetricClaim, locale: PdpGeoLocale): string {
  const entries = [
    semanticMetricContextEntry("timing", claim.timing, locale),
    semanticMetricContextEntry("baseline", claim.baseline, locale),
    semanticMetricContextEntry("comparator", claim.comparator, locale),
    semanticMetricContextEntry("sample", claim.sample, locale),
    semanticMetricContextEntry("period", claim.period, locale),
    semanticMetricContextEntry("method", claim.method, locale),
    semanticMetricContextEntry("institution", claim.institution, locale),
    semanticMetricContextEntry("caveat", claim.caveat, locale)
  ].filter((value): value is string => Boolean(value));

  return entries.join(", ");
}

function semanticMetricContextEntry(kind: "timing" | "baseline" | "comparator" | "sample" | "period" | "method" | "institution" | "caveat", value: string | undefined, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return undefined;
  }
  if (kind === "caveat") {
    return text;
  }
  const labels: Record<PdpGeoLocale, Record<Exclude<typeof kind, "caveat">, string>> = {
    "ko-KR": {
      timing: "시점",
      baseline: "비교 기준",
      comparator: "비교 대상",
      sample: "대상",
      period: "기간",
      method: "방법",
      institution: "기관"
    },
    "ja-JP": {
      timing: "時点",
      baseline: "比較基準",
      comparator: "比較対象",
      sample: "対象",
      period: "期間",
      method: "方法",
      institution: "機関"
    },
    "en-US": {
      timing: "timing",
      baseline: "baseline",
      comparator: "comparator",
      sample: "sample",
      period: "period",
      method: "method",
      institution: "institution"
    },
    "en-GB": {
      timing: "timing",
      baseline: "baseline",
      comparator: "comparator",
      sample: "sample",
      period: "period",
      method: "method",
      institution: "institution"
    }
  };
  return `${labels[locale][kind]} ${text}`;
}

function prefixStructuredMetricSummary(detail: string, locale: PdpGeoLocale): string | undefined {
  const text = trimTrailingSentencePunctuation(cleanSignal(detail));
  if (!text) {
    return undefined;
  }
  if (isStructuredMetricSummary(text)) {
    return ensurePublicSentence(text, locale);
  }
  if (locale === "ko-KR") {
    return `확인 지표: ${text}.`;
  }
  if (locale === "ja-JP") {
    return `確認指標: ${text}。`;
  }
  return `Reported result: ${text}.`;
}

function normalizeReportedDetail(value: string): string | undefined {
  const text = stripSourceSectionLabel(value)
    .replace(/\*/g, "")
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/(\d)(Self-assess)/gi, "$1 $2")
    .replace(/\bFine Lines?\s*&\s*Wrinkles?\b/gi, "fine lines and wrinkles")
    .replace(/\bElasticity\b/g, "elasticity")
    .replace(/\bFirmness\b/g, "firmness")
    .replace(/\bPlumpness\b/g, "plumpness")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || isNonCitationEvidenceArtifact(text) || hasTruncationMarker(text) || isQuestionLikeText(text) || !isReportedEvidenceCandidate(text)) {
    return undefined;
  }

  const agreedAssessment = normalizeAgreedAssessmentDetail(text);
  if (agreedAssessment) {
    return agreedAssessment;
  }

  const koreanMultiMetricDetail = formatKoreanMultiMetricEvidenceDetail(text);
  if (koreanMultiMetricDetail) {
    return koreanMultiMetricDetail;
  }

  const visibleImprovementWithContext = text.match(/(\d+(?:\.\d+)?%)\s+(?:of\s+)?users?\s+had\s+visible\s+improvement\s+in:?\s*(.+?)\s+\*?\s*Instrumental result,\s*(\d+\s+(?:women|men|users|subjects|participants)),\s*after\s+(\d+\s+weeks?)\s+of\s+(daily\s+)?use/i);
  if (visibleImprovementWithContext) {
    const percent = visibleImprovementWithContext[1] ?? "";
    const outcomes = normalizeOutcomeList(visibleImprovementWithContext[2] ?? "");
    const sample = (visibleImprovementWithContext[3] ?? "").toLowerCase();
    const duration = (visibleImprovementWithContext[4] ?? "").toLowerCase();
    const dailyUse = Boolean(visibleImprovementWithContext[5]);
    return `${percent} of users had visible improvement in ${outcomes} after ${duration} of ${dailyUse ? "daily " : ""}use (instrumental result, ${sample})`;
  }

  const improvement = text.match(/after\s+(\d+\s+weeks?)\s+of\s+use\s+(\d+(?:\.\d+)?%)\s+of\s+users?\s+showed\s+improvement\s+in:?\s*(.+)/i);
  if (improvement) {
    const duration = improvement[1];
    const percent = improvement[2];
    const outcomes = normalizeOutcomeList(improvement[3] ?? "");
    const sample = text.match(/\b\d+\s+(?:women|men|users|subjects)\b/i)?.[0];
    const context = /instrumental result/i.test(text) ? ["instrumental result", sample].filter(Boolean).join(", ") : sample;
    return `${percent} of users showed improvement in ${outcomes} after ${duration} of use${context ? ` (${context})` : ""}`;
  }

  const visibleImprovement = text.match(/(\d+(?:\.\d+)?%)\s+(?:of\s+)?users?\s+had\s+visible\s+improvement\s+in:?\s*(.+)/i);
  if (visibleImprovement) {
    const percent = visibleImprovement[1];
    const outcomes = normalizeOutcomeList(visibleImprovement[2] ?? "");
    return `${percent} of users had visible improvement in ${outcomes}`;
  }

  return text;
}

function isReportedEvidenceCandidate(value: string): boolean {
  if (isNonCitationEvidenceArtifact(value)) {
    return false;
  }
  if (isCommerceMetricArtifact(value)) {
    return false;
  }
  if (!hasQuantifiedReportedSignal(value)) {
    return false;
  }
  return /%|\d+(?:\.\d+)?\s*배|weeks?|days?|hours?|clinical|instrumental|study|users?|women|men|subjects?|participants?|agreed|showed|after\s+\d|self-assess|rating|reviews?|임상|인체\s*적용|자가\s*평가|참여자|대상|사용자|테스트|시험|결과|사용\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안)/i.test(value);
}

function hasQuantifiedReportedSignal(value: string): boolean {
  return /%|\d+(?:\.\d+)?\s*배|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|women|men|subjects?|participants?|reviews?|ratings?)\b|평점\s*\d|리뷰\s*\d|\d+(?:\.\d+)?\s*(?:명|회|주|일|시간)|사용\s*\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후/i.test(value);
}

function hasContextualReportedSignal(value: string): boolean {
  const text = trimTrailingSentencePunctuation(cleanSignal(value))
    .replace(/^(?:확인\s*지표|확인\s*근거|평가\s*지표|측정\s*결과|시험\s*결과|reported\s*result|consumer\s*assessment)\s*:\s*/i, "")
    .trim();
  if (!text || !hasQuantifiedReportedSignal(text)) return false;
  if (/^[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배|시간|일|주|weeks?|days?|hours?)$/iu.test(text)) return false;
  return /(?:잔존|보습|수분|장벽|피부|탄력|주름|피부결|진정|회복|개선|감소|증가|상승|향상|완화|지속|도달|사용|도포|세정|시험|테스트|평가|대상|참여자|리뷰|평점|비교|대비|ex\s*vivo|clinical|study|test|assessment|participant|user|review|rating|retention|hydration|moisture|barrier|wrinkle|firmness|improv|increase|decrease|after|versus|\bvs\.?\b)/iu.test(text);
}

function hasMinimumReportedEvidenceContext(value: string): boolean {
  const text = cleanSignal(value);
  if (!hasContextualReportedSignal(text)) {
    return false;
  }
  return /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|측정|평가|임상|in\s*vitro|ex\s*vivo|clinical|study|test|assessment|instrumental|survey|home\s+usage|\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|표본|sample|participants?|subjects?|사용\s*(?:직후|전|후)|도포\s*(?:직후|전|후)|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월|minutes?|weeks?|days?|hours?|months?)\s*(?:후|동안|만에)?|비교|대비|versus|\bvs\.?\b|(?:before|after)\s+(?:use|application)|after\s+\d)/iu.test(text);
}

function isCommerceMetricArtifact(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:공유|쿠폰|적립|배송|구매|장바구니|할인|할인가|판매가|가격|정가|원\b|₩|KRW|coupon|reward|shipping|cart|price|sale)/i.test(text)
    && /(?:%|\d{2,})/.test(text);
}

function normalizeAgreedAssessmentDetail(text: string): string | undefined {
  if (!/\bAGREE(?:D)?\b/i.test(text)) {
    return undefined;
  }

  const normalizedText = normalizeEvidenceText(text);
  const claims = Array.from(normalizedText.matchAll(/(\d+(?:\.\d+)?%)\s+agreed\s+(.+?)(?=(?:\.\s*)?\d+(?:\.\d+)?%\s+agreed\b|\s+(?:Self-assess|Home usage|Instrumental|Clinical)|$)/gi))
    .map((match) => {
      const percent = match[1];
      const claim = cleanAssessmentClaim(match[2] ?? "");
      return percent && claim ? formatAgreedAssessmentClaim(percent, claim) : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (claims.length === 0) {
    return undefined;
  }

  const context = extractEvidenceAssessmentContext(normalizedText) ?? "an assessment";

  return `In ${context}, ${formatDescriptionList(claims, "en-US", 4)}`;
}

function cleanAssessmentClaim(value: string): string | undefined {
  const cleaned = removeEvidenceFootnoteMarkers(value)
    .replace(/\b\d+\s*Self-assess.*$/i, "")
    .replace(/\b\d+\s*Home usage.*$/i, "")
    .replace(/\b\d+\s*Based on.*$/i, "")
    .replace(/\bSelf-assess.*$/i, "")
    .replace(/\bHome usage.*$/i, "")
    .replace(/\bBased on.*$/i, "")
    .replace(/\bskin texture feels\b/gi, "skin texture felt")
    .replace(/\bskin feels\b/gi, "skin felt")
    .replace(/\bfine lines and wrinkles feel\b/gi, "fine lines and wrinkles felt")
    .replace(/\bfeels\b/gi, "felt")
    .replace(/\bfeel\b/gi, "felt")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return undefined;
  }

  return cleaned.toLowerCase();
}

function formatAgreedAssessmentClaim(percent: string, claim: string): string {
  return `${percent} of participants agreed that ${claim}`;
}

function normalizeOutcomeList(value: string): string {
  const canonicalOutcomes = extractCanonicalBenefitTerms(value);
  if (canonicalOutcomes.length > 0) {
    return formatDescriptionList(canonicalOutcomes, "en-US", 4) ?? canonicalOutcomes.join(", ");
  }

  const outcomes = unique(value
    .replace(/\b(?:instrumental result|users?|women|men|subjects?)\b.*$/i, "")
    .split(/\s{2,}|,|\/|;/)
    .flatMap((item) => item.split(/(?<=wrinkles)\s+(?=elasticity|firmness|plumpness)|(?<=elasticity)\s+(?=firmness|plumpness)/i))
    .map(cleanSignal)
    .filter((item) => item.length >= 3)
    .map((item) => item.replace(/\.$/, "")));

  return formatDescriptionList(outcomes, "en-US", 4) ?? cleanSignal(value);
}

function isTerseDurationMetric(value: string): boolean {
  return /^\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|주|일|시간)$/i.test(value.trim());
}

function extractBenefitSignalCandidates(value: string): string[] {
  const cleaned = stripSourceSectionLabel(value);
  if (!cleaned || isNonCitationEvidenceArtifact(cleaned)) {
    return [];
  }
  return unique([
    ...extractCanonicalBenefitTerms(cleaned),
    ...splitBenefitSignal(cleaned).filter(isStandaloneBenefitCandidate)
  ]);
}

function splitBenefitSignal(value: string): string[] {
  const cleaned = stripSourceSectionLabel(value);
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(/\n|;|\||\/|,(?!\s*(?:and|or)\b)/i)
    .map(cleanSignal)
    .filter(Boolean);
}

function normalizeBenefitSignal(value: string): string | undefined {
  const cleaned = stripSourceSectionLabel(value)
    .replace(/\s*:\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isNonCitationEvidenceArtifact(cleaned)) {
    return undefined;
  }
  if (/^fine lines?\s*(?:&|and)\s*wrinkles?$/i.test(cleaned)) {
    return "fine lines and wrinkles";
  }
  if (/^wrinkles?\s*(?:&|and)\s*fine lines?$/i.test(cleaned)) {
    return "fine lines and wrinkles";
  }
  return cleaned;
}

function localizePublicBenefitSignal(value: string, locale: PdpGeoLocale): string | undefined {
  const cleaned = cleanSignal(value)
    .replace(/\s*:\s*$/g, "")
    .replace(/\.$/, "")
    .trim();

  if (!cleaned || hasTruncationMarker(cleaned) || isQuestionLikeText(cleaned) || isBrokenMarketingFragment(cleaned)) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const mappings: Array<[RegExp, string]> = [
      [/anti[-\s]?aging|visible signs? of aging|안티\s*에이징/i, "안티에이징 케어"],
      [/fine lines?\s*(?:&|and)\s*wrinkles?|wrinkles?\s*(?:&|and)\s*fine lines?|주름/i, "주름 케어"],
      [/skin resilience|resilien(?:ce|t)/i, "피부 탄력"],
      [/elasticity|elastic|firmness|firming|firm|탄력/i, "탄력"],
      [/plumpness|plump/i, "탄탄한 피부"],
      [/skin barrier|barrier support|피부\s*장벽|장벽/i, "피부 장벽"],
      [/보습\s*케어|고보습|보습/i, "보습 케어"],
      [/hydration|hydrate|moisture|moisturizing|moisturising|수분감|수분/i, "수분감"],
      [/soothing|soothe|calming|calm|진정/i, "진정 케어"],
      [/low[-\s]?irritation|gentle|mild|마찰\s*자극|저자극|자극/i, "저자극 세안"],
      [/fine\s*dust|ultra[-\s]?fine\s*dust|pollution|초미세먼지/i, "초미세먼지 세정"],
      [/pore\s*(?:waste|impurit|cleansing)|모공\s*속\s*노폐물|노폐물/i, "모공 속 노폐물 세정"],
      [/micro\s*bubble|bubble|마이크로\s*버블|버블|거품/i, "마이크로 버블"],
      [/cleans(?:e|ing)|wash|세정|세안/i, "세정력"],
      [/sebum|oil control|oil|피지|유분/i, "유분 컨트롤"],
      [/smooth(?:ness)?|texture|피부결|매끄/i, "피부결"],
      [/brightening|even-looking tone|광채|화사/i, "광채"],
      [/cooling sensation|cooling|쿨링|시원/i, "쿨링감"]
    ];
    for (const [pattern, replacement] of mappings) {
      if (pattern.test(cleaned)) {
        return replacement;
      }
    }
    return /[가-힣]/.test(cleaned) && !/[A-Za-z]/.test(cleaned) ? cleaned : undefined;
  }

  if (locale === "ja-JP") {
    const mappings: Array<[RegExp, string]> = [
      [/hydration|hydrate|moisture|moisturizing|moisturising|保湿|うるおい/i, "うるおい"],
      [/skin barrier|barrier support|バリア/i, "バリアケア"],
      [/smooth(?:ness)?|texture|キメ/i, "キメ"],
      [/elasticity|firmness|firming|ハリ/i, "ハリ"],
      [/brightening|透明感/i, "透明感"]
    ];
    for (const [pattern, replacement] of mappings) {
      if (pattern.test(cleaned)) {
        return replacement;
      }
    }
  }

  return cleaned;
}

function extractCanonicalBenefitTerms(value: string): string[] {
  const terms: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/anti[-\s]?aging|visible signs? of aging/i, "anti-aging care"],
    [/fine lines?\s*(?:&|and)\s*wrinkles?|wrinkles?\s*(?:&|and)\s*fine lines?/i, "fine lines and wrinkles"],
    [/fine lines?/i, "fine lines and wrinkles"],
    [/dullness|dull/i, "dullness"],
    [/skin resilience|resilien(?:ce|t)/i, "skin resilience"],
    [/elasticity|elastic/i, "elasticity"],
    [/firmness|firming|firm/i, "firmness"],
    [/plumpness|plump/i, "plumpness"],
    [/skin barrier|barrier support|피부\s*장벽|장벽/i, "skin barrier support"],
    [/hydration|hydrate|moisture|moisturizing|moisturising|보습|수분감|保湿|うるおい/i, "hydration"],
    [/soothing|soothe|calming|calm|진정|鎮静/i, "soothing care"],
    [/low[-\s]?irritation|gentle|mild|마찰\s*자극|저자극|자극/i, "low-irritation cleansing"],
    [/fine\s*dust|ultra[-\s]?fine\s*dust|pollution|초미세먼지/i, "fine-dust cleansing"],
    [/pore\s*(?:waste|impurit|cleansing)|모공\s*속\s*노폐물|노폐물/i, "pore waste cleansing"],
    [/micro\s*bubble|bubble|마이크로\s*버블|버블|거품/i, "micro-bubble foam"],
    [/cleans(?:e|ing)|wash|세정|세안/i, "cleansing power"],
    [/sebum|oil control|oil|피지|유분/i, "oil control"],
    [/smooth(?:ness)?|texture|피부결|매끄|キメ/i, "smooth texture"],
    [/brightening|even-looking tone|광채|화사|透明感/i, "brightening"],
    [/cooling|쿨링|시원/i, "cooling sensation"]
  ];

  for (const [pattern, term] of patterns) {
    if (pattern.test(value)) {
      terms.push(term);
    }
  }

  return terms;
}

function isStandaloneBenefitCandidate(value: string): boolean {
  const normalized = cleanSignal(value).replace(/\.$/, "");
  if (normalized.length < 3 || normalized.length > 90) {
    return false;
  }
  if (normalized.split(/\s+/).length > 6) {
    return false;
  }
  if (/^(formulated|enriched|while|after|with|and|or|this|our|their|instrumental result)\b/i.test(normalized)) {
    return false;
  }
  if (/,\s*(?:and|or)\b/i.test(normalized)) {
    return false;
  }
  if (/^\d+|\b(?:women|men|users?|subjects?|instrumental result|capsule technology|technology|nutrients?)\b/i.test(normalized)) {
    return false;
  }
  // A compact label that carries multiple outcome concepts is represented by
  // its canonical atomic benefits; keeping both forms creates repeated joins.
  if (extractCanonicalBenefitTerms(normalized).length >= 2) {
    return false;
  }
  if (/[.:]/.test(normalized)) {
    return false;
  }
  return /benefit|care|hydration|moisture|firm|elastic|wrinkle|fine line|plump|resilien|barrier|smooth|texture|bright|cleanse|cleansing|bubble|보습|수분|탄력|피부결|광채|저자극|세정|세안|거품|버블|노폐물|초미세먼지|保湿|うるおい|ハリ|キメ/i.test(normalized);
}

function normalizeUsageInstruction(value: string): string {
  const normalized = extractUsageInstructionFromMixedEvidence(stripLeadingUsageStepMarkers(stripSourceSectionLabel(value)
    .replace(/\bStep\s+\d+\b\.?/gi, "")
    .replace(/^\s*(?:은|는|이|가|을|를)\s+/u, "")
    .replace(/\s+/g, " ")
    .trim()));
  return isNonCitationEvidenceArtifact(normalized) || isNonInstructionUsageText(normalized) || isEvidenceOnlyUsageCandidate(normalized) ? "" : normalized;
}

function stripLeadingUsageStepMarkers(value: string): string {
  let next = value.trim();
  for (let index = 0; index < 4; index += 1) {
    const before = next;
    next = next
      .replace(/^\s*(?:[.;:·-]+\s*)+/, "")
      .replace(/^\s*(?:step\s*)?\d+\s*(?:단계|段階)\s*[:.)-]*\s*/i, "")
      .replace(/^\s*step\s*\d+\s*[:.)-]*\s*/i, "")
      .replace(/^\s*\d+[.)]?\s+/, "")
      .trim();
    if (next === before) {
      break;
    }
  }
  return next;
}

function stripSourceSectionLabel(value: string): string {
  return cleanSignal(value)
    .replace(/^\[?\s*(?:key\s*ingredients?|ingredients?|ingredient\s*list|full\s*ingredients?)\s*\]?\s*:?\s*/i, "")
    .replace(/^\[?\s*(?:how\s*to\s*use|directions?|usage|사용\s*방법|사용법|使い方|使用方法)\s*\]?\s*:?\s*/i, "")
    .replace(/^\[([^\]]{1,32})\]\s*/g, "")
    .trim();
}

function usageStepKey(value: string): string {
  return normalizeUsageInstruction(value)
    .toLowerCase()
    .replace(/아침\s*(?:과|와|\/|또는)\s*저녁|morning\s*(?:and|or|\/)\s*(?:evening|night)/giu, "morning-night")
    .replace(/이후에/gu, "이후")
    .replace(/피부\s*결/gu, "피부결")
    .replace(/펴\s*(?:바르는\s*것이다|바릅니다|발라\s*주세요|바르세요|바르십시오|바른다)/gu, "펴바르")
    .replace(/(?:적당량|소량)(?:의\s*내용물|을|를)?\s*(?:덜어|취해)?/gu, " ")
    .replace(/(?:부드럽게|고르게|충분히)/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:the|a|an|your|this|it|of|serum|cream|toner|product|an appropriate amount|a small amount)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function usageStepsAreSemanticallyEquivalent(left: string, right: string): boolean {
  const leftKey = usageStepKey(left);
  const rightKey = usageStepKey(right);
  if (!leftKey || !rightKey) {
    return false;
  }
  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    return true;
  }
  if (usagePrimaryActionFamily(left) !== usagePrimaryActionFamily(right)) {
    return false;
  }
  const leftTokens = new Set(leftKey.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(rightKey.split(" ").filter((token) => token.length > 1));
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller === 0) {
    return false;
  }
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / smaller >= 0.75;
}

function usagePrimaryActionFamily(value: string): string {
  const text = cleanSignal(value);
  if (/(?:헹구|씻어|rinse|wash\s*off|すす)/iu.test(text)) return "rinse";
  if (/(?:흡수|두드|누르|pat|press|absorb|なじませ)/iu.test(text)) return "absorb";
  if (/(?:마사지|문지르|massage|rub|マッサージ)/iu.test(text)) return "massage";
  if (/(?:펴\s*바르|바르|도포|apply|spread|smooth|塗)/iu.test(text)) return "apply";
  if (/(?:덜어|펌핑|거품|dispense|pump|lather|取って|泡立)/iu.test(text)) return "prepare";
  return "other";
}

function isCitationEvidenceMetric(metric: string): boolean {
  const normalized = metric.trim();
  if (!/\d/.test(normalized)) {
    return false;
  }
  if (/\b\d+(?:\.\d+)?\s?(?:ml|mL|oz|fl\.?\s?oz)\b/i.test(normalized)) {
    return false;
  }
  return /%|weeks?|days?|hours?|stars?|reviews?|rating|점|개|명|회|주|일|시간|パーセント|週間|日間/i.test(normalized);
}

function isEvidenceOnlyUsageCandidate(value: string): boolean {
  const normalized = cleanSignal(value);
  if (!normalized) {
    return true;
  }
  if (isSafetyOrTestClaimUsageCandidate(normalized)) {
    return true;
  }
  if (/^(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\b/i.test(normalized)) {
    return true;
  }
  if (isKoreanEvidenceOnlyUsageCandidate(normalized)) {
    return true;
  }
  const hasApplicationAction = hasExplicitUsageAction(normalized);
  const looksLikeEvidence = isReportedEvidenceCandidate(normalized)
    || /\b(?:delivers?|helps?|supports?|improves?|boosts?|strengthens?|leaves?|leaving|visible|visibly|instrumental|clinical|self[-\s]?assessment|test(?:ed)?|agreed|showed)\b/i.test(normalized);

  return looksLikeEvidence && !hasApplicationAction;
}

function isNonInstructionUsageText(value: string): boolean {
  return isReviewLikeUsageCandidate(value) || isSafetyOrTestClaimUsageCandidate(value);
}

function isReviewLikeUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  if (isKoreanCustomerReviewNarrativeUsageLeak(text)) {
    return true;
  }
  const hasReviewVoice = /(?:아직|본격적으로|워낙\s*평|평이\s*좋|기대(?:가|되|하)|타\s*제품|사용해\s*보|사용해보|사용해\s*봤|사용해봤|사용했|썼는데|써\s*보|써보|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)/i.test(text);
  return hasReviewVoice && !hasActionableApplicationVerb(text);
}

function isKoreanCustomerReviewNarrativeUsageLeak(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:^|\s)[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text)
    || /(?:아직\s*본격적으로|워낙\s*평|평이\s*좋|기대가\s*많|기대되|고객\s*리뷰|후기|리뷰)/u.test(text)
    || /(?:구매했|구매\s*했|구매했어요|필요해서\s*구매|배송|포장|도착했|득템|저렴한\s*가격|쓰기\s*전부터|쓰기도\s*전부터|기분이\s*정말\s*좋)/u.test(text)
    || /(?:초등학생|딸|아들|남편|어머니|엄마|가족)[^.!?。！？]{0,80}(?:구매|필요|사용|쓰|선크림)/u.test(text)
    || /(?:느낌이네요|느낌입니다|좋습니다|좋네요|좋아요|같아요|같습니다)\s*$/u.test(text) && !hasActionableApplicationVerbWithoutGenericApply(text);
}

function isSafetyOrTestClaimUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:테스트|시험)\s*완료|사용성\s*테스트|피부\s*자극\s*테스트|피부\s*테스트|안자극|하이포알러지|논코메도제닉|민감\s*피부\s*대상|소아와?\s*피부\s*테스트|소아\s*피부\s*테스트/i.test(text)
    || /(?:patch\s*test|patch\s*testing|dermatologist[-\s]?tested|hypoallergenic|non[-\s]?comedogenic|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should|test\s+on\s+a\s+small\s+area)/i.test(text);
}

function extractUsageInstructionFromMixedEvidence(value: string): string {
  let normalized = stripLeadingUsageMeasurementLabels(cleanSignal(value));
  const cueIndex = usageInstructionCueIndex(normalized);
  if (cueIndex > 0 && shouldStartUsageAtCue(normalized.slice(0, cueIndex))) {
    normalized = normalized.slice(cueIndex).trim();
  }
  return normalized
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:사용\s*방법|사용법)\s*\d*[:.]?\s*/iu, "")
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:how\s*to\s*use|directions?)\s*\d*[:.]?\s*/iu, "")
    .replace(usageMeasurementLeadPattern(), "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldStartUsageAtCue(prefix: string): boolean {
  const normalized = cleanSignal(prefix);
  return isEvidenceOnlyUsageCandidate(normalized)
    || usageMeasurementLeadPattern().test(normalized)
    || repeatedUsageMeasurementLabelPattern().test(normalized);
}

function stripLeadingUsageMeasurementLabels(value: string): string {
  return value
    .replace(repeatedUsageMeasurementLabelPattern(), "")
    .replace(usageMeasurementLeadPattern(), "")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedUsageMeasurementLabelPattern(): RegExp {
  return /^(?:(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)\s*){2,}/;
}

function usageMeasurementLeadPattern(): RegExp {
  return /^(?:(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)\s*)+/;
}

function usageInstructionCueIndex(value: string): number {
  const patterns = [
    /사용\s*방법/i,
    /사용법\s*\d*/i,
    /\bhow\s+to\s+use\b/i,
    /\bdirections?\b/i,
    /손에\s*적당량/,
    /화장솜/,
    /\b(?:apply|dispense|massage|pump|lather|rinse|pat|press|smooth)\b/i
  ];
  const indexes = patterns
    .map((pattern) => value.search(pattern))
    .filter((index) => index > -1);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function isKoreanEvidenceOnlyUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  return /[가-힣]/.test(text)
    && /(?:%|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|테스트|시험|결과)/.test(text)
    && /(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|(?:\d+(?:\.\d+)?\s*(?:시간|일|주).{0,20})?(?:\d+\s*회\s*)?(?:사용|도포|측정)\s*후|(?:회복|개선|감소|증가)/.test(text);
}

function hasExplicitUsageAction(value: string): boolean {
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump)\b|なじませ|塗布|使(?:う|い)/i.test(value)
    || hasKoreanInstructionVerb(value)
    || /^\s*use\b/i.test(value)
    || /(?:^|[.;,]\s*)then\s+use\b/i.test(value)
    || /\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b/i.test(value);
}

function sanitizeCategory(value?: string): string | undefined {
  const category = cleanSignal(value ?? "");
  if (!category || category.length > 60 || genericCategoryPattern.test(category)) {
    return undefined;
  }
  return category;
}

function inferProductType(product: PdpProductSignal): string | undefined {
  return resolveProductType(product);
}

function resolveProductType(product: PdpProductSignal): string | undefined {
  const category = sanitizeCategory(product.category);
  const nameType = productTypeFromName(product.name) ?? productTypeFromName(product.originalName ?? "");
  if (category && nameType && shouldPreferNameProductType(category, nameType)) {
    return nameType;
  }
  return category ?? nameType;
}

function shouldPreferNameProductType(category: string, nameType: string): boolean {
  const categoryKey = signalEntityKey(category);
  const nameTypeKey = signalEntityKey(nameType);
  if (!categoryKey || !nameTypeKey || categoryKey === nameTypeKey) {
    return false;
  }
  if (/mist|미스트|ミスト/i.test(nameType) && /cream|크림|クリーム/i.test(category)) {
    return true;
  }
  if (/body\s*lotion|바디\s*로션|바디로션|ボディローション/i.test(nameType) && /lotion|로션|ローション/i.test(category)) {
    return true;
  }
  if (/cleansing\s*foam|foam\s*cleanser|폼\s*클렌저|포밍\s*클렌저/i.test(nameType) && /cleanser|클렌저|폼/i.test(category)) {
    return true;
  }
  return false;
}

function productTypeFromName(value: string): string | undefined {
  const name = cleanSignal(value);
  if (/크림\s*미스트|크림미스트|クリーム\s*ミスト/i.test(name)) {
    return "Cream Mist";
  }
  if (/미스트|ミスト/i.test(name)) {
    return "Mist";
  }
  if (/cream\s*mist/i.test(name)) {
    return "Cream Mist";
  }
  if (/\bmist\b/i.test(name)) {
    return "Mist";
  }
  if (/클렌징|클렌저|세안|폼/.test(name)) {
    return "Cleanser";
  }
  if (/세럼|앰플|에센스/.test(name)) {
    return "Serum";
  }
  if (/크림|크리미/.test(name)) {
    return "Cream";
  }
  if (/cleansing\s+foam|foam\s+cleanser|cleanser|cleaning\s+foam/i.test(name)) {
    return "Cleanser";
  }
  if (/serum|ampoule|essence/i.test(name)) {
    return "Serum";
  }
  if (/cream|moisturi[sz]er/i.test(name)) {
    return "Cream";
  }
  if (/body\s*lotion|lotion|바디\s*로션|바디로션|로션/i.test(name)) {
    return /body\s*lotion|바디\s*로션|바디로션/i.test(name) ? "Body Lotion" : "Lotion";
  }
  if (/toner|skin water/i.test(name)) {
    return "Toner";
  }
  if (/mask/i.test(name)) {
    return "Mask";
  }
  return undefined;
}

function splitIngredientSignal(value: string): string[] {
  return cleanSignal(value)
    .replace(/\s*:\s*WATER\s*\/\s*AQUA[\s\S]*$/i, "")
    .split(/\n|;|,(?=\s*(?:KOREAN|GINSENG|RETINOL|NIACINAMIDE|CERAMIDE|HYALURONIC|SODIUM HYALURONATE)\b)/i)
    .map(cleanSignal)
    .filter(Boolean);
}

function normalizeIngredientSignal(value: string): string | undefined {
  const text = cleanSignal(value);
  if (!text || text.length < 3) {
    return undefined;
  }
  if (isNonCitationEvidenceArtifact(text) || isLowQualityIngredientEvidenceText(text)) {
    return undefined;
  }
  if (/^(ingredients?|ingredient list|key ingredients|full ingredients|전성분|全成分)$/i.test(text)) {
    return undefined;
  }
  if (/with the power of ginseng/i.test(text)) {
    return undefined;
  }
  if (/500[-\s]?hour(?:\s+aged)?\s+ginseng/i.test(text)) {
    return "500-hour aged ginseng";
  }
  if (/korean herb extract/i.test(text)) {
    return "Korean herb extract";
  }
  if (/korean ginseng actives|ginsenomics/i.test(text)) {
    return "Korean Ginseng Actives (Ginsenomics)";
  }
  if (/진세노믹스|ginsenomics/i.test(text)) {
    return "진세노믹스";
  }
  if (/진생\s*펩타이드|진생펩타이드|ginseng peptide/i.test(text)) {
    return "진생펩타이드";
  }
  if (/진생\s*레티놀|진생레티놀|ginseng retinol/i.test(text)) {
    return "진생레티놀";
  }
  const concreteIngredientTechnology = normalizeConcreteIngredientTechnologySignal(text);
  if (concreteIngredientTechnology) {
    return concreteIngredientTechnology;
  }
  if (isBrokenIngredientFragment(text)) {
    return undefined;
  }
  const explicitTechnologyPhrase = normalizeExplicitIngredientTechnologyPhrase(text);
  if (explicitTechnologyPhrase) {
    return explicitTechnologyPhrase;
  }
  if (/ginseng peptide/i.test(text)) {
    return "Ginseng Peptide";
  }
  if (/retinol/i.test(text)) {
    return "Retinol";
  }
  if (/niacinamide/i.test(text)) {
    return "Niacinamide";
  }
  if (/hyaluronic acid|sodium hyaluronate/i.test(text)) {
    return "Hyaluronic Acid";
  }
  if (/zinc/i.test(text)) {
    return "Zinc";
  }
  if (/ceramide/i.test(text)) {
    return "Ceramide";
  }
  if (/징크/i.test(text)) {
    return "징크";
  }
  if (/히알루론산|하이알루론산/i.test(text)) {
    return "히알루론산";
  }
  if (/나이아신아마이드/i.test(text)) {
    return "나이아신아마이드";
  }
  if (/판테놀/i.test(text)) {
    return "판테놀";
  }
  if (/베타인|betaine/i.test(text)) {
    return "베타인";
  }
  if (/프로바이오틱스|probiotics?/i.test(text)) {
    return "프로바이오틱스";
  }
  if (/세라마이드/i.test(text)) {
    return "세라마이드";
  }
  if (/^water\s*\/\s*aqua/i.test(text) || text.split(",").length > 8) {
    return undefined;
  }
  if (hasTruncationMarker(text) || isQuestionLikeText(text) || /[.。！？?]/.test(text) || text.length > 80) {
    return undefined;
  }
  if (/[가-힣]/.test(text) && /(설계|함유|동일|고객님|리뉴얼|화학적 성분|피부타입|피부고민)/.test(text)) {
    return undefined;
  }
  return text;
}

function normalizeConcreteIngredientTechnologySignal(value: string): string | undefined {
  return first(extractConcreteIngredientTechnologySignals(value));
}

function extractConcreteIngredientTechnologySignals(value: string): string[] {
  const text = cleanSignal(value);
  if (!text) {
    return [];
  }
  const signals: string[] = [];
  const capturePatterns = [
    /([가-힣A-Za-z0-9®™+\-]{2,24}\s*세라마이드\s*캡슐)/giu,
    /(세라마이드\s*캡슐)/giu,
    /(\b[A-Z]{2,8}\s*워터\b)/gu,
    /([가-힣A-Za-z0-9®™+\-]{2,24}\s*(?:플로팅\s*)?포뮬러)/giu,
    /(DermaON®?|더마온)(?:\s*기술)?/giu,
    /(콜레스테롤)/gu,
    /(지방산)/gu
  ];
  for (const pattern of capturePatterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = cleanSignal(match[1] ?? "");
      if (!raw) {
        continue;
      }
      signals.push(normalizeConcreteIngredientTechnologyMatch(raw));
    }
  }
  return unique(signals);
}

function normalizeConcreteIngredientTechnologyMatch(value: string): string {
  const text = cleanSignal(value);
  if (/^dermaon®?$/i.test(text) || /^더마온$/i.test(text)) {
    return "DermaON® 기술";
  }
  return text
    .replace(/PHA\s*워터/i, "PHA 워터")
    .replace(/세라마이드\s*캡슐/i, "세라마이드 캡슐")
    .replace(/하이드로겔\s*플로팅\s*포뮬러/i, "하이드로겔 플로팅 포뮬러")
    .replace(/하이드로겔\s*포뮬러/i, "하이드로겔 포뮬러");
}

function normalizeExplicitIngredientTechnologyPhrase(value: string): string | undefined {
  const text = cleanSignal(value);
  if (!text || text.length > 80 || /[.。！？?]/.test(text) || isIngredientSectionLabel(text)) {
    return undefined;
  }
  const hasIngredientAnchor = /ingredient|formula|technology|complex|blend|extract|ferment|peptide|capsule|ceramide|hyaluronic|retinol|niacinamide|zinc|panthenol|betaine|probiotics?|성분|원료|기술|포뮬러|복합체|추출물|발효|펩타이드|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|징크|판테놀|베타인|프로바이오틱스/i.test(text);
  const isGenericSingleAnchor = /^(?:ingredient|formula|technology|complex|blend|extract|ferment|peptide|capsule|ceramide|hyaluronic acid|retinol|niacinamide|zinc|panthenol|betaine|probiotics?|성분|원료|기술|포뮬러|복합체|추출물|발효|펩타이드|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|징크|판테놀|베타인|프로바이오틱스)$/i.test(text);
  const hasModifier = text.split(/\s+/).length >= 2 || /[-™®]/.test(text) || /^[가-힣A-Za-z0-9™®-]+(?:\s+[가-힣A-Za-z0-9™®-]+)+$/.test(text);

  return hasIngredientAnchor && hasModifier && !isGenericSingleAnchor ? text : undefined;
}

function isUsefulBenefitSignal(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 180) {
    return false;
  }
  if (/^(reviews?|ratings?|usage|use|ingredients?|effects?|benefits?|positive notes?|key benefit|key benefits)$/i.test(normalized)) {
    return false;
  }
  if (/(?:효과\s*\*|REJUVENATING|CRÈME|AGREED|자가\s*평가|소비자\s*평가|인체\s*적용|시험|테스트|%|\d+(?:\.\d+)?\s*(?:명|주|일|시간))/i.test(normalized)) {
    return false;
  }
  return true;
}

function isUsageInstruction(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 280) {
    return false;
  }
  if (normalized.length < 18 && !hasActionableApplicationVerb(normalized)) {
    return false;
  }
  if (isEvidenceOnlyUsageCandidate(normalized) || isQuestionLikeText(normalized)) {
    return false;
  }
  if (isQuantifiedClinicalResultSentence(normalized)
    || /(?:실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b)[^.!?。！？]{0,100}(?:높|증가|감소|개선|잔존|효과|효능|reported|result|higher|increase|decrease|improv)/i.test(normalized)) {
    return false;
  }
  if (isNonInstructionUsageText(normalized)) {
    return false;
  }
  if (isProductDescriptionUsageCandidate(normalized)) {
    return false;
  }
  if (isNonProceduralUsageCandidate(normalized)) {
    return false;
  }
  if (isIngredientTechnologyUsageLeak(normalized)) {
    return false;
  }
  if (isSensoryOnlyUsageInstruction(normalized)) {
    return false;
  }
  if (isConciseStandaloneUsageStep(normalized)) {
    return true;
  }
  if (normalized.split(/\s+/).length < 4 && !hasConcreteKoreanUsageAction(normalized)) {
    return false;
  }
  return isProceduralUsageInstruction(normalized);
}

function isConciseStandaloneUsageStep(value: string): boolean {
  const text = cleanSignal(value);
  if (text.length < 8 || text.length > 80 || !hasExplicitUsageAction(text)) {
    return false;
  }
  return (
    /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|pump|take)\b/i.test(text)
    && /\b(?:water|face|skin|hands?|palms?|neck|product|amount)\b/i.test(text)
  ) || (
    hasConcreteKoreanUsageAction(text)
    && /(?:적당량|손에|물과\s*함께|거품|얼굴|미온수|헹구|화장솜|덜어|펴\s*바르|흡수)/.test(text)
  );
}

function isProductDescriptionUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  if (!/[가-힣]/.test(text)) {
    const declarativeProductSubject = /^(?:yes,?\s*)?(?:this|the)?\s*(?:[\w-]+\s+){0,5}(?:product|serum|cream|lotion|toner|essence|formula)\s+(?:absorbs?|layers?|feels?|leaves?|provides?|delivers?|supports?|helps?)/i.test(text);
    const directInstruction = /^(?:use|apply|dispense|massage|rinse|pat|press|smooth|warm|take)\b|\b(?:should|then)\s+(?:use|apply|dispense|massage|rinse|pat|press)\b/i.test(text);
    return declarativeProductSubject && !directInstruction;
  }

  return /사용할\s*수\s*있는|사용\s*가능/.test(text)
    || /(?:제품|상품|클렌저|클렌징|폼|토너|크림|세럼|로션|미스트|포뮬라|성분|캡슐)[^.!?。！？\n]{0,100}(?:제시|설명|표방|함유|구성|전달|위한|입니다|된다|됩니다)/.test(text);
}

function isProceduralUsageInstruction(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return false;
  }
  const proceduralScore = usageProcedureSignalScore(text);
  const descriptiveScore = usageDescriptionSignalScore(text);
  if ((hasDescriptiveApplicationFrame(text) || hasSensoryEvaluationFrame(text)) && proceduralScore < 3) {
    return false;
  }
  return (hasProcedureActionCue(text) || hasRoutinePlacementCue(text))
    && proceduralScore >= 2
    && proceduralScore >= descriptiveScore;
}

function isNonProceduralUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || (!hasProcedureActionCue(text) && !hasRoutinePlacementCue(text))) {
    return false;
  }
  return !isProceduralUsageInstruction(text) && usageDescriptionSignalScore(text) > 0;
}

function usageProcedureSignalScore(value: string): number {
  const text = cleanSignal(value);
  return [
    /(?:적당량|소량|충분량|손바닥|손에|화장솜|얼굴|피부결|미온수|물과\s*함께|appropriate amount|small amount|palm|hands?|cotton pad|face|skin|neck|water|適量|手のひら|顔|肌|コットン)/i.test(text) ? 1 : 0,
    hasProcedureActionCue(text) ? 1 : 0,
    /(?:후|뒤|다음|먼저|마지막|단계|순서|때는|then|after|before|next|finally|step|when|後|次|最後)/i.test(text) ? 1 : 0,
    /(?:주세요|줍니다|합니다|하세요|하십시오|바릅니다|흡수시킵니다|헹굽니다|사용할\s*수\s*있|\buse\b|\bapply\b|\bdispense\b|ます|してください)/i.test(text) ? 1 : 0,
    /(?:아침|저녁|매일|데일리|morning|night|daily|twice|once|朝|夜|毎日)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function usageDescriptionSignalScore(value: string): number {
  const text = cleanSignal(value);
  return [
    hasDescriptiveApplicationFrame(text) ? 2 : 0,
    hasSensoryEvaluationFrame(text) ? 2 : 0,
    /(?:케어|개선|도움|효과|효능|추천|위한|민감|건조|보습|수분|장벽|care|benefit|helps?|supports?|improves?|recommended|for\s+\w+|効果|ケア|改善|おすすめ|向け)/i.test(text) ? 1 : 0,
    /(?:성분|원료|캡슐|포뮬러|기술|ingredient|formula|technology|capsule|成分|処方|技術|カプセル)/i.test(text) ? 1 : 0,
    /(?:제품|상품|토너|크림|세럼|로션|클렌저|product|toner|cream|serum|lotion|cleanser|商品|製品|化粧水|クリーム|美容液)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function hasDescriptiveApplicationFrame(value: string): boolean {
  return /(?:바르는\s*순간|사용(?:할\s*때마다|하는\s*순간)|도포\s*직후|on\s+application|upon\s+application|when\s+(?:used|applied)|with\s+each\s+use|塗った瞬間|使用(?:時|する瞬間)|使うたび)/i.test(value);
}

function hasSensoryEvaluationFrame(value: string): boolean {
  return /(?:테스트|시험|사용감|마무리감|수분감|보습감|흡수감|끈적임|산뜻|촉촉|느껴지는|진정되는|피부가\s*진정|부드러운|피부결이\s*부드러운|use[-\s]?feel|finish(?:es)?|non[-\s]?sticky|stickiness|fresh\s+feel|dewy|soothing|skin\s+feels?\s+smooth|tested?|sensory|使用感|仕上がり|べたつき|さっぱり|しっとり|うるおい感|なめらか|落ち着|テスト|試験|感じられる)/i.test(value);
}

function hasProcedureActionCue(value: string): boolean {
  return /(?:덜어|적셔|올려두|펴\s*바르|펴\s*발라|두드려|흡수(?!감)|마사지|문지르|헹구|헹굽|거품|도포(?!감)|마무리(?:해|하세요|합니다|하십시오)|사용(?:해|하세요|합니다|하십시오|할\s*수\s*있)|apply|dispense|spread|smooth|pat|press|absorb|massage|lather|rinse|pump|take|use\s+as|なじませ|塗布|すすぎ|マッサージ)/i.test(value);
}

function hasRoutinePlacementCue(value: string): boolean {
  return /(?:아침|저녁|매일|데일리|스킨케어|샤워\s*후|세안\s*후|마지막\s*단계|첫\s*단계|루틴|morning|night|daily|routine|after\s+(?:cleansing|shower)|last\s+step|first\s+step|朝|夜|毎日|スキンケア|洗顔後|最後のステップ)/i.test(value);
}

function isIngredientTechnologyUsageLeak(value: string): boolean {
  const text = cleanSignal(value);
  const hasFormulaOrTechnology = /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|펩타이드|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide|成分|技術|処方|フォーミュラ|複合体|カプセル|セラミド|ヒアルロン酸|レチノール|ナイアシンアミド|ペプチド)/i.test(text);
  const hasInstructionCue = /(?:사용\s*방법|사용법|\bhow\s+to\s+use\b|\bdirections?\b|使い方|使用方法|適量|手のひら|顔全体|肌になじませ|塗布|すすぎ|マッサージ|적당량|손에|얼굴에|피부결|펴\s*바르|발라|흡수|도포|massage|apply|dispense|pat|press|spread|smooth|rinse|lather)/i.test(text);
  const hasOnlyDescriptiveUse = /(?:사용할\s*때마다|사용\s*시|when\s+used|with\s+each\s+use|使用時|使うたび)/i.test(text) && !hasInstructionCue;
  const hasTechnologyUseFrame = /(?:성분|기술|포뮬러|복합체|캡슐)[^.!?。！？]{0,60}(?:사용|적용|쓰(?:인|이는)|활용)|(?:uses?|using|applies?)[^.!?]{0,60}(?:ingredient|formula|technology|complex|capsule)|(?:成分|技術|処方|フォーミュラ|複合体|カプセル)[^.!?。！？]{0,60}(?:使用|採用|配合|活用)/i.test(text);
  const hasReportingFrame = /(?:적용|설계|제공|도출|방출|설명|특징|구성|함유|담(?:긴|은)|녹지\s*않|patent|proprietary|designed|delivers?|provides?|contains?|features?|採用|設計|提供|説明|特徴|構成|配合|含有|特許|独自)/i.test(text);
  const hasActionableApplication = hasActionableApplicationVerb(text);
  return hasFormulaOrTechnology && (hasOnlyDescriptiveUse || hasTechnologyUseFrame || hasReportingFrame) && !hasActionableApplication;
}

function hasActionableApplicationVerb(value: string): boolean {
  const text = cleanSignal(value);
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump)\b|なじませ|塗布/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후)))/.test(text);
}

function hasActionableApplicationVerbWithoutGenericApply(value: string): boolean {
  const text = cleanSignal(value);
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump)\b|なじませ|塗布/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후)))/.test(text);
}

function hasConcreteKoreanUsageAction(value: string): boolean {
  return hasKoreanInstructionVerb(value);
}

function hasKoreanInstructionVerb(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|사용\s*(?:해|하세요|합니다|하십시오|한다|하시)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
}

function isSensoryOnlyUsageInstruction(value: string): boolean {
  return /\b(?:take\s+a\s+deep\s+breath|inhale|scent|fragrance|aroma)\b/i.test(value)
    && !/\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|skin|face|neck)\b/i.test(value);
}

function isReviewKeyword(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 32) {
    return false;
  }
  if (/^(review|reviews|rating|ratings|star|stars|customer|keyword|keywords|ingredient|ingredients)$/i.test(normalized)) {
    return false;
  }
  if (/^[A-Z0-9\s-]{8,}$/.test(normalized)) {
    return false;
  }
  return /보습|흡수|탄력|피부결|순한|만족|촉촉|매끄|광채|장벽|사계절|편안|자극\s*(?:없|없이|적)|끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않|texture|smooth|hydration|moist|moisture|firm|elastic|lightweight|non[-\s]?sticky|gentle|rich|absorbs|glow|plump|うるおい|保湿|ハリ|なじみ|満足/i.test(normalized);
}

function isMeaningfulReviewBody(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 20 || normalized.length > 600) {
    return false;
  }
  if (isRatingSummaryText(normalized)) {
    return false;
  }
  if (/^(review|rating|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length >= 4 || /[가-힣ぁ-んァ-ン]/.test(normalized);
}

function isRatingSummaryText(value: string): boolean {
  const normalized = cleanSignal(value)
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:rating|평점|評価)?\s*\d(?:\.\s*\d+)?\s*(?:\/\s*5)?\s*(?:stars?)?\s+\d[\d,]*\s+(?:reviews?|ratings?|리뷰|후기)$/i.test(normalized)
    || /^(?:rating|평점|評価)\s+\d(?:\.\s*\d+)?\s*(?:\/\s*5)?$/i.test(normalized);
}

function cleanSignal(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
}

function allProductEvidenceText(product: PdpProductSignal): string {
  return [
    product.name,
    product.originalName,
    product.description,
    product.brand,
    product.category,
    product.price?.raw,
    ...product.options,
    ...product.benefits,
    ...product.effects,
    ...product.ingredients,
    ...product.usage,
    ...product.metrics,
    ...product.faq.flatMap((item) => [item.question, item.answer]),
    ...product.reviews.items.map((item) => item.body),
    ...product.reviews.keywords,
    ...product.sourceTexts,
    ...(product.semanticFacts?.ingredients ?? []),
    ...(product.semanticFacts?.benefits ?? []),
    ...(product.semanticFacts?.effects ?? []),
    ...(product.semanticFacts?.skinTypes ?? []),
    ...(product.semanticFacts?.usageSteps ?? []),
    ...(product.semanticFacts?.safetyTests ?? []),
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ].filter((value): value is string => Boolean(value)).map(cleanSignal).join(" ");
}

function nonReviewProductEvidenceText(product: PdpProductSignal): string {
  const reviewKeys = new Set([
    ...product.reviews.items.map((item) => item.body),
    ...product.reviews.keywords
  ].map(signalEntityKey).filter(Boolean));
  return [
    product.name,
    product.originalName,
    product.description,
    product.brand,
    product.category,
    ...product.benefits,
    ...product.effects,
    ...product.ingredients,
    ...product.faq.flatMap((item) => [item.question, item.answer]),
    ...product.sourceTexts,
    ...(product.semanticFacts?.benefits ?? []),
    ...(product.semanticFacts?.effects ?? []),
    ...(product.semanticFacts?.skinTypes ?? []),
    ...(product.semanticFacts?.safetyTests ?? []),
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ]
    .filter((value): value is string => Boolean(value))
    .map(cleanSignal)
    .filter((value) => !reviewKeys.has(signalEntityKey(value)))
    .join(" ");
}

function formatClaimSentences(values: Array<string | undefined>, locale: PdpGeoLocale): string | undefined {
  const sentences = values
    .map((value) => formatClaimSentence(value, locale))
    .filter((value): value is string => Boolean(value));

  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

function formatClaimSentence(value: string | undefined, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return undefined;
  }
  if (/[.!?。！？]$/.test(text)) {
    return text;
  }
  return `${text}${locale === "ja-JP" ? "。" : "."}`;
}

function isQuestionLikeText(value: string): boolean {
  const text = value.trim();
  return /[?？]$/.test(text)
    || /(인가요|나요|까요|무엇인가요|어떤가요|궁금(?:합니다|해요)?|알고\s*싶(?:습니다|어요)?)\s*[.!。]?[?？]?$/.test(text)
    || /\b(?:i\s+wonder|would\s+like\s+to\s+know|want\s+to\s+know)\b/i.test(text);
}

function isBrokenMarketingFragment(value: string): boolean {
  const text = value.trim();
  if (/(property value|Evidence signal|Review signals|technology signals|main benefit signal)/i.test(text)) {
    return true;
  }
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  if (openParens !== closeParens) {
    return true;
  }
  return false;
}

function isUsefulPublicListValue(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 280 || hasTruncationMarker(text) || isQuestionLikeText(text) || isBrokenMarketingFragment(text) || isNonCitationEvidenceArtifact(text) || isLowQualityPublicEvidenceText(text)) {
    return false;
  }
  if (/^(review|reviews|rating|ratings|star|stars|ingredient|ingredients|effect|benefit|search intent context|review comfort context)$/i.test(text)) {
    return false;
  }
  if (/\b(?:search intent context|review comfort context|comparison cues include|product discovery context|use-feel language|benefit terms|ingredient terms)\b/i.test(text)) {
    return false;
  }
  return true;
}

function isUsefulPositiveNoteValue(value: string): boolean {
  const text = cleanSignal(value);
  if (!isUsefulPublicListValue(text) || text.length > 90) {
    return false;
  }
  if (/(?:케어\s*케어|성분으로|효능어|성분어|기반\s+.+\s+기반|,\s*[^,]+,\s*[^,]+)/u.test(text)) {
    return false;
  }
  return true;
}

function isLowQualityIngredientEvidenceText(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return true;
  }
  if (isLegalDisclosureText(text) || isCommercePolicyText(text)) {
    return true;
  }
  return /(?:성분\s*정보가\s*충분하지|ingredient\s+information\s+is\s+not\s+sufficient|no\s+ingredient\s+evidence)/i.test(text);
}

function isLowQualityPublicEvidenceText(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return true;
  }
  if (hasKoreanSurfaceQualityIssue(text) || hasEnglishSurfaceQualityIssue(text)) {
    return true;
  }
  if (isLegalDisclosureText(text)) {
    return true;
  }
  return isCommercePolicyText(text) && !hasCareOrFormulaSignal(text);
}

function isLegalDisclosureText(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:화장품법|법령|고시|기재\s*[ㆍ·]?\s*표시|표시하여야|전성분[^.!?。！？\n]{0,40}(?:법|고시)|all\s+ingredients\s+required\s+by\s+law|statutory\s+ingredient|legal\s+disclosure|regulatory\s+disclosure|regulation\s+requires)/i.test(text);
}

function isCommercePolicyText(value: string): boolean {
  return /(?:배송|반품|교환|환불|쿠폰|할인|적립|혜택\s*적용가|구매\s*혜택|고객센터|판매자|배송비|무료배송|shipping|returns?|refund|exchange|coupon|discount|reward|points?|customer\s+service|seller)/i.test(cleanSignal(value));
}

function hasCareOrFormulaSignal(value: string): boolean {
  return /(?:보습|수분|진정|탄력|장벽|광채|영양|피부결|주름|성분|기술|포뮬러|제형|텍스처|사용감|hydration|moisture|soothing|firming|barrier|radiance|wrinkle|ingredient|formula|technology|texture|finish)/i.test(value);
}

function hasKoreanSurfaceQualityIssue(value: string): boolean {
  const text = cleanSignal(value);
  return /제품로|(?:합니다|줍니다|입니다)입니다|(?:세요|주세요)입니다|으로으로|로로|사용감\s+사용감|[가-힣]{2,}(?:을|를|이|가|은|는|으로|로)(?:가|이)\b/.test(text)
    || isKoreanMetaNarrationText(text)
    || isKoreanInternalGenerationFrame(text);
}

function isKoreanMetaNarrationText(value: string): boolean {
  const text = cleanSignal(value);
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  const sourceSubject = "(?:상품|제품|페이지|상품\\s*상세|상품\\s*정보|제품\\s*정보|제품\\s*자료|확인(?:된)?\\s*(?:근거|정보|결과)|근거|내용|자료|성분\\s*영역|효능\\s*정보|리뷰\\s*(?:기반\\s*)?표현)";
  const reportingPredicate = "(?:정리|요약|제시|설명|노출|포함|구성)";
  return new RegExp(`${sourceSubject}.{0,28}(?:은|는|에는|에서는|으로는|로|를|을)?[^.!?。！？\\n]{0,48}${reportingPredicate}(?:하|되|됩|합니다|됩니다)`).test(text);
}

function isKoreanInternalGenerationFrame(value: string): boolean {
  return /(?:성분\s*역할|효능\s*문맥|핵심\s*케어\s*근거|효능어|성분어|사용감어|탐색\s*문맥)/.test(cleanSignal(value));
}

function hasEnglishSurfaceQualityIssue(value: string): boolean {
  const text = cleanSignal(value);
  return isEnglishMetaNarrationText(text)
    || /\b(?:Evidence signal|Review signals|technology signals|main benefit signal|ingredient signal|product discovery context|comparison intent|comparison-led|use-feel language|benefit language|ingredient terms|benefit terms)\b/i.test(text);
}

function isEnglishMetaNarrationText(value: string): boolean {
  const text = cleanSignal(value);
  if (!/[A-Za-z]/.test(text)) {
    return false;
  }
  const sourceSubject = "(?:source-backed\\s+)?(?:product\\s+)?(?:evidence|source\\s+evidence|source\\s+material|product-detail\\s+evidence|product\\s+detail\\s+context|usage\\s+guidance|texture\\s+context|routine\\s+context|reported\\s+benefit\\s+cues)";
  const reportingPredicate = "(?:reports?|includes?|adds?|organizes?|organises?|presents?|summari[sz]es?|covers?|supports?|reflects?|states?|can\\s+be\\s+compared|is\\s+described|is\\s+framed)";
  return new RegExp(`\\b${sourceSubject}\\b[^.!?\\n]{0,56}\\b${reportingPredicate}\\b`, "i").test(text);
}

function dedupePublicListValues(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values.map(cleanSignal).filter(Boolean)) {
    const key = publicListDedupeKey(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(value);
  }
  return results;
}

function publicListDedupeKey(value: string): string {
  const key = normalizePublicReviewKeywordSurface(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (/(?:보습|수분감|촉촉)/u.test(key) || /\b(?:hydration|hydrate|moisture|moisturizing|moisturising|moist)\b/.test(key) || /(?:うるおい|保湿)/u.test(key)) {
    return "hydration";
  }
  if (/(?:자극\s*(?:없|없이|적)|순한|편안)/u.test(key) || /\b(?:gentle|mild|nonirritating|non irritating)\b/.test(key)) {
    return "gentle";
  }
  if (/(?:끈적임(?:이|은)?\s*(?:없|없이|적)|끈적이지\s*않|산뜻|가벼운)/u.test(key) || /\b(?:lightweight|nonsticky|non sticky)\b/.test(key)) {
    return "lightweight";
  }
  if (/\b(?:firmness|firming|firm|탄력|ハリ)\b/.test(key)) {
    return "firmness";
  }
  if (/\b(?:elasticity|elastic)\b/.test(key)) {
    return "elasticity";
  }
  if (/\b(?:smooth|smoothness|smooth texture|texture|피부결|キメ)\b/.test(key)) {
    return "smooth texture";
  }
  if (/\b(?:fine lines?|wrinkles?)\b/.test(key)) {
    return "fine lines and wrinkles";
  }
  return key;
}

function normalizePublicEvidenceText(value: string, locale: PdpGeoLocale): string | undefined {
  const text = sanitizeProductSchemaText(value, locale);
  if (!text || isNonCitationEvidenceArtifact(text) || hasTruncationMarker(text) || isQuestionLikeText(text) || isBrokenMarketingFragment(text)) {
    return undefined;
  }
  return text;
}

function isNonCitationEvidenceArtifact(value: string): boolean {
  return isUrlOrImageArtifact(value) || isVisualDescriptionArtifact(value);
}

function isUrlOrImageArtifact(value: string): boolean {
  const normalized = value
    .replace(/https?\s*:\s*\/\s*\//gi, "https://")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\?\s*/g, "?")
    .trim();
  return /https?:\/\/|www\.|data:image\//i.test(normalized)
    || /\.(?:jpe?g|png|webp|gif|avif|svg)(?:\?|$)/i.test(normalized)
    || /fileupload\/reviews/i.test(normalized);
}

function isVisualDescriptionArtifact(value: string): boolean {
  const text = cleanSignal(value);
  if (!text) {
    return false;
  }

  const visualMarker = /\b(?:product\s+shot|pack\s*shot|model|person\s+applying|applying\s+(?:a\s+)?(?:skincare\s+)?product|face\s+shot|thumbnail|hero\s+image|lifestyle\s+image|image|photo|bottle|tube|jar|package|packaging|facial\s+cleanser)\b/i;
  if (!visualMarker.test(text)) {
    return false;
  }

  const citationReadyFact = /(?:\d+(?:\.\d+)?%|after\s+\d|clinical|study|participants?|agreed|showed|ingredients?|formula|technology|how\s+to\s+use|directions?|apply|massage|rinse|water\s*\/\s*aqua|glycerin|niacinamide|retinol|peptide|ceramide|hyaluronic|extract|성분|전성분|사용법|효과|개선|수분|보습|장벽|탄력|피지|주름)/i;
  return !citationReadyFact.test(text);
}

function createQuickFacts(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  guidance: GeoOptimizationGuidance
): string {
  const claimSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const expressionPhrases = selectQuickFactExpressionPhrases(product, locale, 4);
  const reportedDetail = guidance.useEvidenceBackedClaims ? selectEvidenceSignal(product, locale) : undefined;
  const publicReportedDetail = reportedDetail && isHardEvidenceSignal(reportedDetail) ? reportedDetail : undefined;
  const reportedMetricFact = guidance.useEvidenceBackedClaims
    ? createStructuredClinicalEvidenceSummary(product, locale) ?? createEvidenceMetricFact(publicReportedDetail, locale)
    : undefined;
  const ingredientEffectDetail = createIngredientEffectDetailProperty(product, locale, claimSentences[0]);
  const facts = [
    quickFactSentence(locale, "Target", createTargetCustomerProperty(product, locale)),
    quickFactSentence(locale, "Recommended skin type", inferRecommendedSkinType(product, locale)),
    quickFactSentence(locale, "Key benefit", selectPublicPrimaryBenefit(product, locale, localizedTerms)),
    quickFactSentence(locale, "Key ingredients", selectLocalizedKeyIngredients(product, locale, 5).join(", ")),
    quickFactSentence(locale, "Ingredient/effect detail", formatClaimSentence(ingredientEffectDetail, locale)),
    quickFactSentence(locale, "Search context", formatExpressionPhrases(expressionPhrases, locale)),
    quickFactSentence(locale, "Customer reviews", selectPublicReviewKeywords(product, locale).slice(0, 4).join(", ")),
    quickFactSentence(locale, "Reported details", reportedMetricFact)
  ].filter((value): value is string => Boolean(value));

  return facts.length > 0 ? facts.join("\n") : fallback(locale, {
    "ko-KR": "입력 상품 JSON에서 확인 가능한 핵심 정보가 부족합니다.",
    "ja-JP": "入力された商品JSONから確認できる主要情報が不足しています。",
    "en-US": "The input product JSON does not include enough quick fact details.",
    "en-GB": "The input product JSON does not include enough quick fact details."
  });
}

function selectQuickFactExpressionPhrases(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return selectGroundedExpressionPhrases(product, locale, limit + 4)
    .map((value) => normalizePublicReviewKeywordSurface(value))
    .filter((value) => value.length <= 90)
    .filter((value) => !/[A-Z]{4,}.*[A-Z]{4,}/.test(value))
    .filter((value) => !/(?:REJUVENATING|CRÈME|AGREED|자가\s*평가|소비자\s*평가|인체\s*적용|시험|테스트|%|\d+(?:\.\d+)?\s*(?:명|주|일|시간))/i.test(value))
    .filter((value) => !/(?:리뷰\s*표현|review\s+language|확인\s*지표|확인\s*근거)/i.test(value))
    .filter(isUsefulPublicListValue)
    .slice(0, limit);
}

function createBenefitsSection(product: PdpProductSignal, locale: PdpGeoLocale, guidance: GeoOptimizationGuidance): string {
  const optimizedValues = createOptimizedBenefitBullets(product, locale, guidance)
    .filter(isPublicBenefitSectionBullet)
    .slice(0, 8);
  const values = optimizedValues.length > 0
    ? optimizedValues
    : createPublicBenefitSectionBullets(product, locale, guidance).filter(isPublicBenefitSectionBullet).slice(0, 8);
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できるベネフィット情報が十分ではありません。",
    "en-US": "The product JSON does not include enough benefit details.",
    "en-GB": "The product JSON does not include enough benefit details."
  });
}

function createPublicBenefitSectionBullets(product: PdpProductSignal, locale: PdpGeoLocale, guidance: GeoOptimizationGuidance): string[] {
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 5);
  const ingredients = formatDescriptionList(selectLocalizedKeyIngredients(product, locale, 3), locale, 3);
  const targetCustomer = guidance.useTargetCustomerContext ? createTargetCustomerProperty(product, locale) : undefined;
  const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "product", locale);

  return unique(benefits.map((benefit, index) => {
    if (locale === "ko-KR") {
      const target = targetCustomer && index === 0 ? `${targetCustomer}이 ${appendKoreanObjectParticle(productType)} 선택할 때 ` : "";
      const ingredient = ingredients && index <= 1 ? ` ${formatKoreanIngredientTopicPhrase(ingredients)} 해당 효능의 성분 맥락을 보완합니다` : "";
      return `${benefit}: ${target}${appendKoreanObjectParticle(benefit)} 확인할 수 있는 핵심 효능입니다.${ingredient}`;
    }
    if (locale === "ja-JP") {
      const target = targetCustomer && index === 0 ? `${targetCustomer}が比較しやすい` : "";
      const ingredient = ingredients && index <= 1 ? ` ${ingredients}の成分文脈とつながります。` : "";
      return `${benefit}: ${target}主なベネフィットです。${ingredient}`;
    }
    const target = targetCustomer && index === 0 ? ` for ${targetCustomer}` : "";
    const ingredient = ingredients && index <= 1 ? ` Key ingredients include ${ingredients}.` : "";
    return `${capitalizeFirst(benefit)}: a source-backed benefit${target}.${ingredient}`;
  }));
}

function createOptimizedBenefitBullets(product: PdpProductSignal, locale: PdpGeoLocale, guidance: GeoOptimizationGuidance): string[] {
  if (locale === "ko-KR") {
    return createKoreanOptimizedBenefitBullets(product, guidance);
  }

  const claimedBenefits = selectClaimedBenefitSignals(product, locale);
  const benefits = (claimedBenefits.length > 0 ? claimedBenefits : selectPublicBenefitSignals(product, locale)).slice(0, 6);
  const targetCustomer = guidance.useTargetCustomerContext ? inferTargetCustomer(product, locale) : undefined;
  const ingredients = selectLocalizedKeyIngredients(product, locale, 3);
  const ingredient = ingredients.join(", ");
  const usage = first(selectUsageInstructions(product));
  const ocrBenefitContexts = createOcrBlendedBenefitContexts(product, locale);
  const baseBullets = benefits.map((benefit, index) => {
    const context = index === 0 ? targetCustomer : undefined;
    const ingredientSignal = index <= 1 ? ingredient : undefined;
    const usageSignal = index === 2 ? usage : undefined;
    const ocrSignal = ocrBenefitContexts.length > 0 ? ocrBenefitContexts[index % ocrBenefitContexts.length] : undefined;

    switch (locale) {
      case "ja-JP":
        return compactSentence([
          `${benefit}: ${context ? `${context}に伝えやすい主なベネフィットです` : "商品情報から確認できるベネフィットです"}`,
          ingredientSignal ? `${truncate(ingredientSignal, 90)}などの成分・技術とつながります` : undefined,
          usageSignal ? `${truncate(usageSignal, 90)}という使用シーンで理解できます` : undefined,
          ocrSignal
        ]);
      case "en-GB":
      case "en-US":
      default:
        return compactSentence([
          `${benefit}: ${context ? `a core care point for ${context}` : "a skin-care benefit shoppers can compare by formula and use context"}`,
          ingredientSignal ? `Key ingredients include ${truncate(ingredientSignal, 90)}` : undefined,
          usageSignal ? `Texture and routine details come from ${truncate(usageSignal, 90)}` : undefined,
          ocrSignal
        ]);
    }
  });

  return unique(baseBullets).slice(0, 8);
}

function createKoreanOptimizedBenefitBullets(product: PdpProductSignal, guidance: GeoOptimizationGuidance): string[] {
  const locale: PdpGeoLocale = "ko-KR";
  const claimedBenefits = selectClaimedBenefitSignals(product, locale);
  const benefits = (claimedBenefits.length > 0 ? claimedBenefits : selectPublicBenefitSignals(product, locale)).slice(0, 6);
  const targetCustomer = guidance.useTargetCustomerContext ? inferTargetCustomer(product, locale) : undefined;
  const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "제품", locale);
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
  const usage = first(selectUsageInstructions(product).flatMap(splitUsageInstruction));
  const expressionPhrases = selectGroundedExpressionPhrases(product, locale, 6);
  const ocrBenefitContexts = createOcrBlendedBenefitContexts(product, locale).filter(isSafeKoreanOcrBenefitContext);
  const supportedLink = selectFaqIngredientBenefitLink(product, locale);

  const baseBullets = benefits.map((benefit, index) => {
    const benefitObject = appendKoreanObjectParticle(benefit);
    const benefitCare = formatKoreanBenefitCareSubject(benefit);
    const contextSentence = targetCustomer && index === 0
      ? `${targetCustomer}이 ${appendKoreanObjectParticle(productType)} 선택할 때 ${benefitObject} 우선 고려할 수 있습니다`
      : `${benefitCare}는 제품 선택에서 확인할 핵심 효능입니다`;
    const ingredientSentence = supportedLink && index % 3 === 0
      ? `${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다`
      : undefined;
    const reviewSentence = reviewPhrase && (index % 3 === 1 || benefits.length === 1)
      ? `리뷰 표현인 ${reviewPhrase}는 ${benefit}와 함께 사용감 판단에 도움을 줍니다`
      : undefined;
    const expressionSentence = index === 0 ? formatKoreanBenefitExpressionSentence(first(expressionPhrases)) : undefined;
    const ocrSignal = ocrBenefitContexts.length > 0 ? ocrBenefitContexts[index % ocrBenefitContexts.length] : undefined;
    return compactSentence([
      `${benefit}: ${contextSentence}`,
      ingredientSentence,
      reviewSentence,
      expressionSentence,
      ocrSignal
    ]);
  });

	  return unique(baseBullets).slice(0, 8);
	}

function formatKoreanBenefitCareSubject(benefit: string): string {
  const text = cleanSignal(benefit);
  return /(?:케어|개선|강화|진정|컨트롤|관리)$/u.test(text) ? text : `${text} 케어`;
}

function isSafeKoreanOcrBenefitContext(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 260 || hasKoreanSurfaceQualityIssue(text)) {
    return false;
  }
  if (/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|소비자\s*평가|실험|시험|테스트|측정|평가\s*결과|사용\s*(?:전|후)|도포\s*(?:전|후)|대비|\bvs\.?\b)/iu.test(text)) {
    return false;
  }
  return !/(?:^|\s)1\s+[^.!?。！？]{2,100}(?:^|\s)2\s+/u.test(text);
}

function formatKoreanBenefitExpressionSentence(value: string | undefined): string | undefined {
  const phrase = trimTrailingSentencePunctuation(cleanSignal(value ?? ""));
  if (!phrase || hasKoreanSurfaceQualityIssue(phrase) || /(?:^|\s)1\s+[^.!?。！？]{2,80}(?:^|\s)2\s+/u.test(phrase)) {
    return undefined;
  }
  if (isKoreanCompleteSentence(phrase)) {
    return phrase;
  }
  return undefined;
}

function isPublicBenefitSectionBullet(value: string): boolean {
  const text = stripPublicListMarker(cleanSignal(value));
  if (!text || isLowQualityPublicEvidenceText(text) || hasFaqCitationNoise(text)) {
    return false;
  }
  return !(/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(text)
    && /(?:임상|인체\s*적용|자가\s*평가|소비자\s*평가|실험|시험|테스트|측정|평가|결과|사용\s*(?:전|후)|도포\s*(?:전|후)|대비|\bvs\.?\b|clinical|study|test|measurement|assessment|result|self[-\s]?assessment|instrumental|participants?|subjects?|women|men|users?)/i.test(text));
}

function createIngredientsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 8);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 3);
  const fullIngredients = selectPublicFullIngredientStatements(product, locale, 1);
  const values = unique([
    ...ingredients,
    ...ingredientDetails,
    ...fullIngredients
  ].map((value) => normalizeInferencePublicText(value, locale)))
    .filter(isPublicIngredientSectionLine)
    .slice(0, 12);

  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 성분 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できる成分情報が十分ではありません。",
    "en-US": "The product JSON does not include enough ingredient details.",
    "en-GB": "The product JSON does not include enough ingredient details."
  });
}

function selectPublicFullIngredientStatements(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return selectFullIngredientStatements(product, limit)
    .map((value) => formatFullIngredientStatement(value, locale))
    .filter(isPublicIngredientSectionLine)
    .slice(0, limit);
}

function isPublicIngredientSectionLine(value: string): boolean {
  const text = stripPublicListMarker(cleanSignal(value));
  if (!text
    || isLowQualityPublicEvidenceText(text)
    || hasFaqCitationNoise(text)
    || hasTruncationMarker(text)
    || isQuestionLikeText(text)
    || isDanglingKoreanIngredientFragment(text)
    || /(?:알고\s*싶|궁금|문의|아래와?\s*같은\s*명칭|확인하실\s*수|현재\s+.{0,50}(?:총\s*)?\d+가지)/iu.test(text)) {
    return false;
  }
  const isFullIngredientStatement = /^(?:전성분|全成分|full ingredients?|ingredients?)\s*:/i.test(text);
  if (isFullIngredientStatement) {
    return text.length <= 900 && text.split(",").length <= 45;
  }
  if (text.length > 220 || text.split(",").length > 8) {
    return false;
  }
  if (/\b(?:customer reviews?|review-backed|review language|routine|usage guidance|how to use|apply|morning|night|search intent|comparison cues|reported details)\b/i.test(text)) {
    return false;
  }
  if (/(?:리뷰|후기|사용감\s*표현|루틴|사용법)/i.test(text) && !/(?:성분|기술|포뮬러|추출|펩타이드|레티놀|세라마이드|히알루론산|나이아신아마이드|징크|판테놀|베타인|ingredient|formula|technology|extract|peptide|retinol|ceramide|hyaluronic)/i.test(text)) {
    return false;
  }
  return true;
}

function stripPublicListMarker(value: string): string {
  return value
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*(?:Q|A)[.:]\s*/i, "")
    .trim();
}

function createOptimizedUsageSteps(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  guidance: GeoOptimizationGuidance
): string[] {
  const supplementalSteps = unique([
    ...(product.semanticFacts?.usageSteps ?? []),
    ...selectSupplementalStepwiseUsageInstructions(product)
  ]);
  const usage = unique([
    ...selectUsageInstructions(product),
    ...supplementalSteps
  ]);
  if (usage.length === 0) {
    return [];
  }

  const shouldSplitUsage = guidance.useStepwiseUsage || usage.some(hasNumberedUsageStepDelimiter);
  const rawSteps = shouldSplitUsage
    ? uniqueUsageSteps(usage.flatMap(splitUsageInstruction)).slice(0, 4)
    : usage.slice(0, 4);
  const productScopedSteps = rawSteps.filter((step) => (
    isUsageInstruction(step)
    && (hasConcreteKoreanUsageAction(step) || !isConflictingProductUsageInstruction(step, product))
  ));
  for (const step of supplementalSteps) {
    if (productScopedSteps.length >= 4) {
      break;
    }
    const key = usageStepKey(step) || cleanSignal(step);
    if (key && isUsageInstruction(step) && !productScopedSteps.some((item) => (usageStepKey(item) || cleanSignal(item)) === key)) {
      productScopedSteps.push(step);
    }
  }

  return uniqueUsageSteps(productScopedSteps.map((step) => rewriteUsageStep(step, locale)))
    .filter((step) => isNarrativeLocaleCompatible(step, locale));
}

function normalizePlannedHowToSteps(
  steps: Array<{ name: string; text: string }>,
  locale: PdpGeoLocale
): Array<{ name: string; text: string }> {
  const results: Array<{ name: string; text: string }> = [];
  for (const step of steps) {
    const text = rewriteUsageStep(step.text, locale);
    const key = usageStepKey(text);
    if (!key
      || !isNarrativeLocaleCompatible(text, locale)
      || !isUsageInstruction(text)
      || results.some((item) => usageStepsAreSemanticallyEquivalent(item.text, text))) {
      continue;
    }
    results.push({
      name: normalizeInferencePublicText(step.name, locale) || text,
      text
    });
  }
  return results.length >= 2 ? results : [];
}

function selectSupplementalStepwiseUsageInstructions(product: PdpProductSignal): string[] {
  return unique([
    ...product.sourceTexts.filter(hasOfficialUsageInstructionSectionCue),
    ...selectAdjacentUsageInstructionSourceTexts(product.sourceTexts)
  ]
    .flatMap(splitUsageInstructionSegments)
    .map(normalizeUsageInstruction)
    .filter((value): value is string => Boolean(value))
    .filter((value) => isUsageInstruction(value) || hasConcreteKoreanUsageAction(value))
    .filter((value) => hasConcreteKoreanUsageAction(value) || !isConflictingProductUsageInstruction(value, product)));
}

function hasNumberedUsageStepDelimiter(value: string): boolean {
  return /\s(?:후|뒤)\s+\d+\s+(?=(?:미온수|물|깨끗|충분|헹구|다음|이후))/u.test(cleanSignal(value));
}

function splitUsageInstruction(value: string): string[] {
  const sentences = splitUsageInstructionSegments(value)
    .map(normalizeUsageInstruction)
    .map((item) => cleanSignal(item.replace(/\.$/, "")))
    .filter((item) => item.length >= 12);

  return sentences.length > 0 ? sentences : [normalizeUsageInstruction(value)].filter(Boolean);
}

function splitUsageInstructionSegments(value: string): string[] {
  const cleaned = cleanSignal(value)
    .replace(/,\s*then\b/gi, ". Then")
    .replace(/\bthen\b/gi, ". Then")
    .replace(/^\s*\d+\s+/, "")
    .replace(/\s+(?:후|뒤)\s+\d+\s+(?=(?:미온수|물|깨끗|충분|헹구))/g, " 후. ")
    .replace(/\s*;\s*/g, ". ");

  return cleaned
    .split(/\.\s+/)
    .map((item) => cleanSignal(stripLeadingUsageStepMarkers(item.replace(/\.$/, ""))))
    .filter((item) => item.length >= 12);
}

function uniqueUsageSteps(values: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const value of values.map(normalizeUsageInstruction).filter(Boolean)) {
    const key = usageStepKey(value);
    if (!key || seen.has(key) || results.some((item) => usageStepsAreSemanticallyEquivalent(item, value))) {
      continue;
    }
    seen.add(key);
    results.push(value);
  }

  return results;
}

function rewriteUsageStep(
  step: string,
  locale: PdpGeoLocale
): string {
  const sourceStep = normalizeUsageInstruction(step).replace(/\.$/, "");
  const standaloneStep = sourceStep.replace(/^then\s+/i, "");
  const stepWithEntity = locale === "en-US" || locale === "en-GB"
    ? capitalizeFirst(standaloneStep)
    : standaloneStep;

  switch (locale) {
    case "ko-KR":
      return ensurePublicSentence(rewriteKoreanUsageActionSentence(stepWithEntity), locale).replace(/\.$/, "");
    case "ja-JP":
    case "en-GB":
    case "en-US":
    default:
      return ensurePublicSentence(stepWithEntity, locale).replace(/\.$/, "");
  }
}

function rewriteKoreanUsageActionSentence(value: string): string {
  return trimTrailingSentencePunctuation(cleanSignal(value))
    .replace(/^\s*(?:은|는|이|가|을|를)\s+/u, "")
    .replace(/펴\s*바르는\s*것이다$/u, "펴 바릅니다")
    .replace(/펴\s*바른다$/u, "펴 바릅니다")
    .replace(/흡수시킨다$/u, "흡수시킵니다")
    .replace(/마사지한다$/u, "마사지합니다")
    .replace(/헹군다$/u, "헹굽니다")
    .replace(/사용한다$/u, "사용합니다");
}

function createHowToUseSection(product: PdpProductSignal, locale: PdpGeoLocale, optimizedUsageSteps: string[]): string {
  const usage = uniqueUsageSteps(optimizedUsageSteps.length > 0 ? optimizedUsageSteps : selectUsageInstructions(product))
    .filter((value) => isNarrativeLocaleCompatible(value, locale));
  return usage.length > 0 ? usage.map((value, index) => `${index + 1}. ${value}`).join("\n") : "";
}

function createFaqSection(faq: PdpGeoFaqItem[], _locale: PdpGeoLocale): string {
  if (faq.length === 0) {
    return "";
  }

  return faq.map((item) => `Q. ${item.question}\nA. ${item.answer}`).join("\n\n");
}

function ensureFaq(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  guidance: GeoOptimizationGuidance,
  optimizedUsageSteps: string[]
): PdpGeoFaqItem[] {
  const usage = first(selectUsageInstructions(product).filter((value) => isNarrativeLocaleCompatible(value, locale)));
  const optimizedUsage = first(optimizedUsageSteps) ?? usage;
  const ingredient = formatDescriptionList(selectLocalizedKeyIngredients(product, locale, 3), locale, 3);
  const benefit = first(selectClaimedBenefitSignals(product, locale)) ?? first(selectPublicBenefitSignals(product, locale));
  const evidence = selectEvidenceSignal(product, locale);
  const customerOutcomeEvidence = createStructuredClinicalEvidenceSummary(product, locale)
    ?? createGroundedSuitabilityStudyContext(product, locale)
    ?? first(selectDescriptionEfficacyDetails(product, locale, 1));
  const reviewIntentKeywords = hasPublicReviewEvidence(product, locale) ? selectReviewIntentFaqKeywords(product, locale).slice(0, 3) : [];
  const reviewSignals = reviewIntentKeywords.join(", ");
  const reviewDerivedSearchQueries = createReviewDerivedSearchQueries(product, locale);
  const sourceFaqIntents = product.faq.flatMap(classifySourceFaqIntent);
  const sourceFaq = selectSourceFaqForPublicUse(product.faq, locale, productName, faqStructuredClaimEvidence(product));
  const sourcePublicIntentSet = new Set(sourceFaq.flatMap(classifySourceFaqIntent));
  const hasUsableSourceReviewFaq = sourceFaq.some((item) =>
    isExplicitReviewFaqCandidateQuestion(item.question) && !isReviewBasedFaqCandidate(item, locale)
  );
  const ocrFaqContexts = createOcrFaqBlendContexts(product, locale);
  const recommendedSkinType = inferRecommendedSkinType(product, locale);
  const inferredTargetCustomer = inferTargetCustomer(product, locale);
  const hasSpecificTargetCustomer = isSpecificTargetCustomer(inferredTargetCustomer, locale);
  const textureFinish = selectTextureFinishSignal(product, locale);
  const routineSynergy = selectRoutineSynergySignal(product, locale);
  const variantComparison = selectVariantComparisonSignal(product, locale);
  const inferredCustomerConcern = locale === "ko-KR" ? inferKoreanFaqCustomerConcern(nonReviewProductEvidenceText(product)) : undefined;
  const faq: PdpGeoFaqItem[] = [];

  if (benefit && !sourcePublicIntentSet.has("benefit")) {
    const benefitCandidate = {
      question: fallback(locale, {
        "ko-KR": inferredCustomerConcern
          ? `${appendKoreanSubjectParticle(inferredCustomerConcern)} 고민인 고객에게 ${appendKoreanTopicParticle(productName)} 어떤 효과가 있나요?`
          : `${appendKoreanTopicParticle(productName)} 어떤 피부 고민과 효능에 적합한가요?`,
        "ja-JP": `${productName}はどのような肌悩みやベネフィットに向いていますか？`,
        "en-US": `What skin concerns and benefits does ${productName} address?`,
        "en-GB": `What skin concerns and benefits does ${productName} address?`
      }),
      answer: createBenefitFaqAnswer(product, locale, productName, benefit, ingredient, customerOutcomeEvidence, guidance, ocrFaqContexts.benefit)
    };
    faq.push(benefitCandidate);
  }
  if (ingredient && !sourcePublicIntentSet.has("ingredient")) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}에서 강조되는 성분/기술은 무엇인가요?`,
        "ja-JP": `${productName}で強調される成分・技術は何ですか？`,
        "en-US": `Which ingredients or technologies are highlighted for ${productName}?`,
        "en-GB": `Which ingredients or technologies are highlighted for ${productName}?`
      }),
      answer: createIngredientFaqAnswer(locale, productName, ingredient, benefit, ocrFaqContexts.ingredient)
    });
  }
  if (optimizedUsage && !sourcePublicIntentSet.has("usage")) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${appendKoreanTopicParticle(productName)} 어떻게 사용하나요?`,
        "ja-JP": `${productName}はどのように使うとよいですか？`,
        "en-US": `How should ${productName} be used?`,
        "en-GB": `How should ${productName} be used?`
      }),
      answer: createUsageFaqAnswer(locale, productName, optimizedUsage, benefit, ingredient, undefined, ocrFaqContexts.usage)
    });
  }
  if ((guidance.useReviewIntentFaq || reviewSignals) && reviewSignals && !hasUsableSourceReviewFaq) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `고객 리뷰는 ${productName}의 어떤 사용감을 강조하나요?`,
        "ja-JP": `レビューでは${productName}のどの使用感が強調されていますか？`,
        "en-US": `What do customer reviews highlight about ${productName}?`,
        "en-GB": `What do customer reviews highlight about ${productName}?`
      }),
      answer: createReviewIntentFaqAnswer(locale, productName, reviewSignals, benefit, undefined)
    });
  }
  const reviewDerivedFaqQueries = hasPublicReviewEvidence(product, locale)
    ? reviewDerivedSearchQueries
    : reviewDerivedSearchQueries.filter((query) => query.source === "product-fact");
  for (const query of reviewDerivedFaqQueries.slice(0, 3)) {
    faq.push({
      question: query.question,
      answer: removeMisroutedReviewContextFromFaqAnswer(query.question, query.answer, locale)
    });
  }
  if ((sourceFaqIntents.includes("suitability") || recommendedSkinType || hasSpecificTargetCustomer) && benefit) {
    faq.push({
      question: createSuitabilityFaqQuestion(product, locale, productName),
      answer: createSuitabilityFaqAnswer(
        product,
        locale,
        productName,
        benefit,
        ingredient,
        evidence,
        ocrFaqContexts.benefit ?? ocrFaqContexts.ingredient
      )
    });
  }
  if (textureFinish) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}의 제형이나 사용감은 어떤가요?`,
        "ja-JP": `${productName}のテクスチャーや使用感はどのようなものですか？`,
        "en-US": `What is the texture or finish of ${productName}?`,
        "en-GB": `What is the texture or finish of ${productName}?`
      }),
      answer: createTextureFaqAnswer(locale, productName, textureFinish, benefit)
    });
  }
  if (routineSynergy) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${appendKoreanTopicParticle(productName)} 어떤 루틴에서 함께 쓰기 좋나요?`,
        "ja-JP": `${productName}はどのようなルーティンで使えますか？`,
        "en-US": `How can ${productName} fit into a skincare routine?`,
        "en-GB": `How can ${productName} fit into a skincare routine?`
      }),
      answer: createRoutineSynergyFaqAnswer(locale, productName, routineSynergy, optimizedUsage, ingredient)
    });
  }
  if (variantComparison) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName} 선택 시 어떤 버전이나 옵션을 비교하면 좋나요?`,
        "ja-JP": `${productName}を選ぶとき、どのバージョンやオプションを比べるとよいですか？`,
        "en-US": `Which version or option should shoppers compare for ${productName}?`,
        "en-GB": `Which version or option should shoppers compare for ${productName}?`
      }),
      answer: createVariantComparisonFaqAnswer(locale, productName, variantComparison)
    });
  }
  if (guidance.useEvidenceBackedClaims && (evidence || reviewSignals) && !sourcePublicIntentSet.has("evidence")) {
    const evidenceCandidate = {
      question: createEvidenceFaqQuestion(locale, productName, evidence),
      answer: createEvidenceFaqAnswer(locale, evidence, reviewSignals)
    };
    if (hasExternalAuthorityEvidenceSignal(product, evidence)) {
      faq.push(evidenceCandidate);
    }
  }

  const faqLimit = resolveFaqIntentCoverageLimit({
    product,
    sourceFaq,
    sourceFaqIntents,
    hasBenefit: Boolean(benefit),
    hasIngredient: Boolean(ingredient),
    hasUsage: Boolean(optimizedUsage),
    hasReview: Boolean(reviewSignals),
    hasEvidence: Boolean(evidence),
    hasTexture: Boolean(textureFinish),
    hasRoutineSynergy: Boolean(routineSynergy),
    hasVariantComparison: Boolean(variantComparison),
    useAnswerReadyFaq: guidance.useAnswerReadyFaq
  });

  const primaryCandidates = [
    ...sourceFaq.map((item) => ({ item, sourceBacked: true })),
    ...faq.map((item) => ({ item, sourceBacked: false }))
  ];
  const ranked = rankFaqCandidatesForCitation(primaryCandidates, product, locale, productName, faqLimit);
  // FAQ is evidence- and intent-limited, never quota-filled. Suppressed
  // candidates stay omitted: a missing FAQ is safer than a generic question
  // that the PDP cannot answer directly.
  return ensureHighValueSourceFaqCoverage(ranked, sourceFaq, locale, faqLimit);
}

function ensureHighValueSourceFaqCoverage(ranked: PdpGeoFaqItem[], sourceFaq: PdpGeoFaqItem[], locale: PdpGeoLocale, limit: number): PdpGeoFaqItem[] {
  const result = [...ranked];
  const highValueSourceItems = sourceFaq.filter((item) => isFaqLocaleCompatible(item, locale)
    && /(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(item.question)
    && /(?:사용|쓸\s*수|가능|use|suitable|使用|使え)/iu.test(item.question));
  for (const item of highValueSourceItems) {
    const key = normalizeFaqQuestionKey(item.question);
    if (!key || result.some((candidate) => normalizeFaqQuestionKey(candidate.question) === key)) {
      continue;
    }
    result.splice(Math.min(3, result.length), 0, item);
  }
  return result.slice(0, limit);
}

function resolveFaqIntentCoverageLimit(input: {
  product: PdpProductSignal;
  sourceFaq: PdpGeoFaqItem[];
  sourceFaqIntents: Array<"benefit" | "ingredient" | "usage" | "review" | "suitability" | "evidence">;
  hasBenefit: boolean;
  hasIngredient: boolean;
  hasUsage: boolean;
  hasReview: boolean;
  hasEvidence: boolean;
  hasTexture: boolean;
  hasRoutineSynergy: boolean;
  hasVariantComparison: boolean;
  useAnswerReadyFaq: boolean;
}): number {
  if (!input.useAnswerReadyFaq && input.sourceFaq.length === 0) {
    return 0;
  }
  const evidenceText = allProductEvidenceText(input.product);
  const hasClinicalOrMetric = input.hasEvidence
    || /%|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|clinical|study|participants?|subjects?|users?/i.test(evidenceText);
  const hasSensitiveSkin = /민감|저자극|sensitive|hypoallergenic|dermatolog/i.test(evidenceText);
  const hasRenewal = /리뉴얼|단종|대체|renewal|discontinued|replacement/i.test(evidenceText);
  const hasGift = /선물|기프트|gift|present/i.test(evidenceText);
  const sourceIntentCoverage = new Set(input.sourceFaqIntents).size;
  const coverageCount = [
    input.hasBenefit,
    input.hasIngredient,
    input.hasUsage,
    input.hasReview,
    input.sourceFaqIntents.includes("suitability") || hasSensitiveSkin,
    hasClinicalOrMetric,
    input.hasTexture,
    input.hasRoutineSynergy,
    input.hasVariantComparison,
    hasRenewal,
    hasGift
  ].filter(Boolean).length;

  if (coverageCount >= 8 || input.sourceFaq.length >= 8 || sourceIntentCoverage >= 5) {
    return 8;
  }
  if (coverageCount >= 5 || input.sourceFaq.length >= 6 || sourceIntentCoverage >= 4) {
    return 6;
  }
  return Math.max(input.sourceFaq.length, 3);
}

function rankFaqCandidatesForCitation(
  candidates: Array<{ item: PdpGeoFaqItem; sourceBacked: boolean; preferred?: boolean }>,
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  limit: number
): PdpGeoFaqItem[] {
  const normalized = candidates
    .map((candidate, index) => {
	      const item = normalizeGeneratedFaqItem(candidate.item, locale, productName);
	      if (!item
	        || isLowQualityFaqItem(item)
	        || !isFaqLocaleCompatible(item, locale, [productName, product.originalName, product.brand])
	        || isReviewBasedFaqCandidate(item, locale)
	        || hasProductSpecificFaqQualityIssue(item, product)
	        || !isFaqQuestionAnswerAligned(item, product, locale, candidate.sourceBacked)) {
        return undefined;
      }
      return {
        item,
        sourceBacked: candidate.sourceBacked,
        preferred: candidate.preferred === true,
        index,
        score: scoreFaqCandidateForCitation(item, product, locale, productName, candidate.sourceBacked)
      };
    })
    .filter((value): value is { item: PdpGeoFaqItem; sourceBacked: boolean; preferred: boolean; index: number; score: number } => Boolean(value))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const seen = new Set<string>();
  const results: Array<{
    item: PdpGeoFaqItem;
    sourceBacked: boolean;
    preferred: boolean;
    semanticKeys: string[];
    semanticPreference: number;
  }> = [];
  for (const candidate of normalized) {
    const key = normalizeFaqQuestionKey(candidate.item.question);
    if (!key || seen.has(key)) {
      continue;
    }
    const semanticKeys = createFaqSemanticDedupeKeys(candidate.item, locale);
    const semanticPreference = scoreFaqSemanticDedupePreference(
      candidate.item,
      product,
      productName,
      candidate.sourceBacked
    );
    const conflictIndexes = semanticKeys.length > 0
      ? results.flatMap((selected, index) => hasFaqSemanticDedupeConflict(semanticKeys, selected.semanticKeys) ? [index] : [])
      : [];
    if (conflictIndexes.length > 0) {
      const existingCandidates = conflictIndexes
        .map((index) => results[index])
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const existing = existingCandidates
        .sort((left, right) => Number(right.preferred) - Number(left.preferred)
          || right.semanticPreference - left.semanticPreference)[0];
      // Provenance contributes to semanticPreference, but a thin source FAQ
      // can still yield to a more answer-ready grounded synthesis. Specific
      // source concern/effect questions receive an additional specificity
      // score and remain preferred over generic summaries.
      const shouldReplace = existing && (candidate.preferred !== existing.preferred
        ? candidate.preferred
        : semanticPreference > existing.semanticPreference);
      const winner = shouldReplace
        ? {
          item: candidate.item,
          sourceBacked: candidate.sourceBacked,
          preferred: candidate.preferred,
          semanticKeys,
          semanticPreference
        }
        : existing;
      // A candidate can bridge more than one semantic key (for example a
      // target+concern question can overlap both a suitability question and
      // another concern question). Collapse the complete conflict set instead
      // of removing only the first match and leaving a transitive duplicate.
      const insertionIndex = Math.min(...conflictIndexes);
      for (const index of [...conflictIndexes].sort((left, right) => right - left)) {
        results.splice(index, 1);
      }
      if (winner) {
        results.splice(Math.min(insertionIndex, results.length), 0, winner);
      }
      if (shouldReplace) {
        seen.add(key);
      }
      continue;
    }
    seen.add(key);
    results.push({
      item: candidate.item,
      sourceBacked: candidate.sourceBacked,
      preferred: candidate.preferred,
      semanticKeys,
      semanticPreference
    });
  }

  return results
    .map((result, index) => ({ item: result.item, index }))
    .sort((left, right) => faqCoveragePriority(right.item) - faqCoveragePriority(left.item) || left.index - right.index)
    .map(({ item }) => item)
    .slice(0, limit);
}

function faqCoveragePriority(item: PdpGeoFaqItem): number {
  const question = cleanSignal(item.question);
  if (/(?:고민|손상|민감|건조|장벽|주름|탄력|concern|damaged|sensitive|dry|barrier|wrinkle|firm|悩み|敏感|乾燥|バリア)/iu.test(question)
    && /(?:고객|피부|customers?|skin|方|肌)/iu.test(question)
    && /(?:효능|효과|도움|benefits?|effects?|help|support|効果)/iu.test(question)) return 500;
  if (/(?:누구|어떤\s*(?:고객|피부|대상)|추천\s*(?:대상|고객)|적합|who\s+is|best\s+suited|suitable|どんな.*(?:人|肌)|誰|向いて)/iu.test(question)) return 450;
  if (isDirectIngredientBenefitFaqQuestion(question, /[가-힣]/u.test(question) ? "ko-KR" : "en-US")) return 400;
  if (/(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(question)
    && /(?:사용|쓸\s*수|가능|use|suitable|使用|使え)/iu.test(question)) return 380;
  if (/(?:효능|효과|장점|benefits?|effects?|効果)/iu.test(question)) return 300;
  if (/(?:성분|기술|ingredient|technology|formula|成分|技術)/iu.test(question)) return 280;
  if (/(?:옵션|용량|사이즈|가격|본품|소용량|리필|버전|option|size|price|full[-\s]?size|mini|refill|variant|容量|価格|本品|ミニ|リフィル)/iu.test(question)) return 260;
  if (/(?:사용|루틴|apply|use|routine|使い方|使用)/iu.test(question)) return 80;
  return 100;
}

function createFaqSemanticDedupeKeys(item: PdpGeoFaqItem, locale: PdpGeoLocale): string[] {
  const question = cleanSignal(item.question);
  if (!question) {
    return [];
  }
  const keys: string[] = [];
  if (isDirectIngredientBenefitFaqQuestion(question, locale)) {
    keys.push("ingredient-benefit-overview");
  }
  if (isIngredientOverviewFaqQuestion(question, locale)) {
    keys.push("ingredient-overview");
  }
  if (isSuitabilityOverviewFaqQuestion(question, locale)) {
    keys.push("suitability-overview");
  }
  if (isGenericBenefitOverviewFaqQuestion(question, locale)) {
    keys.push("benefit-overview");
  }
  if (isTargetConcernEffectSuitabilityFaq(item, locale)) {
    keys.push("target-concern-effect-suitability");
  }
  if (isExplicitReviewFaqCandidateQuestion(question)) {
    keys.push("review-overview");
  }
  return keys;
}

function isFaqLocaleCompatible(item: PdpGeoFaqItem, locale: PdpGeoLocale, allowedEntities: Array<string | undefined> = []): boolean {
  const text = `${item.question} ${item.answer}`;
  if (locale === "ja-JP") {
    return /[\u3040-\u30ff]/u.test(text)
      && !/\b(?:when|which|what|positive reviews?|customer reviews?|shoppers?|should shoppers|product is|product page|formula highlights|skin texture|daily use|routine)\b/i.test(text);
  }
  if (locale === "ko-KR") {
    return /[가-힣]/u.test(text) && !/^[A-Za-z][^가-힣]{20,}[?？]/u.test(item.question);
  }
  const narrativeText = allowedEntities.reduce<string>((current, entity) => {
    const normalizedEntity = cleanSignal(entity ?? "");
    return normalizedEntity ? current.replace(new RegExp(escapeRegExp(normalizedEntity), "giu"), " ") : current;
  }, text).replace(/\s+/g, " ").trim();
  return !/[\u3040-\u30ff\uac00-\ud7a3]/u.test(narrativeText);
}

function hasFaqSemanticDedupeConflict(nextKeys: string[], selectedKeys: string[]): boolean {
  return nextKeys.some((nextKey) => selectedKeys.includes(nextKey));
}

function scoreFaqSemanticDedupePreference(
  item: PdpGeoFaqItem,
  product: PdpProductSignal,
  productName: string,
  sourceBacked = false
): number {
  const question = cleanSignal(item.question);
  const answer = cleanSignal(item.answer);
  return [
    sourceBacked ? 12 : 0,
    isSpecificConcernEffectFaqQuestion(question) ? 18 : 0,
    isDirectIngredientBenefitFaqQuestion(question, "ko-KR") || isDirectIngredientBenefitFaqQuestion(question, "en-US") ? 40 : 0,
    isGenericBenefitOverviewFaqQuestion(question, "ko-KR") || isGenericBenefitOverviewFaqQuestion(question, "en-US") ? 20 : 0,
    isTargetConcernEffectSuitabilityFaq(item, /[가-힣]/u.test(question) ? "ko-KR" : "en-US") ? 30 : 0,
    containsEntityToken(question, productName) || product.brand && containsEntityToken(question, product.brand) ? 6 : 0,
    isDirectIngredientBenefitFaqQuestion(question, "ko-KR") || isDirectIngredientBenefitFaqQuestion(question, "en-US")
      ? hasPublicReviewEvidence(product, "ko-KR") || hasPublicReviewEvidence(product, "en-US") ? 30 : -10
      : 0,
    /(?:성분|기술|ingredient|formula|technology)/i.test(`${question} ${answer}`) ? 5 : 0,
    /(?:효능|효과|보습|장벽|수분|탄력|주름|benefit|effect|hydration|barrier|firm|wrinkle)/i.test(`${question} ${answer}`) ? 5 : 0,
    /(?:\d+(?:\.\d+)?\s*%|\d+\s*(?:시간|일|주|명|회|hours?|days?|weeks?|participants?))/.test(answer) ? 4 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function isSpecificConcernEffectFaqQuestion(question: string): boolean {
  const text = cleanSignal(question);
  return /(?:고민인|고민이\s*있는|손상된|건조한|민감한)[^?？]{0,90}(?:고객|피부)[^?？]{0,90}(?:효능|효과|도움)/u.test(text)
    || /\b(?:customers?|people|skin)\s+(?:with|experiencing)\b[^?!.]{0,100}\b(?:benefits?|effects?|help|support|address)/iu.test(text)
    || /\b(?:what|how)\b[^?!.]{0,80}\b(?:benefits?|effects?|help|support|address)\b[^?!.]{0,100}\b(?:dry|sensitive|damaged|barrier|wrinkle|firmness|texture)\b/iu.test(text);
}

function isIngredientOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(question);
  if (locale === "ko-KR") {
    return /(?:(?:주요|핵심|강조되는)\s*(?:성분|성분\/기술)|(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:무엇|뭔가요|있나요))/u.test(text);
  }
  if (locale === "ja-JP") {
    return /(?:主な|主要な|強調される)?(?:成分|技術)[^?？。]{0,30}(?:何|どれ)/u.test(text);
  }
  return /\b(?:which|what|key|main|primary|highlighted)\b[^?!.]{0,60}\b(?:ingredients?|formula|technolog(?:y|ies))\b/iu.test(text);
}

function isSuitabilityOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(question);
  if (/(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(text)) {
    return false;
  }
  if (locale === "ko-KR") {
    return /(?:어떤\s*(?:고객|피부|대상)|누구(?:에게)?|추천\s*(?:대상|고객)|적합|피부\s*타입)/u.test(text);
  }
  if (locale === "ja-JP") {
    return /(?:どんな.*(?:人|肌)|誰|向いて|肌タイプ)/u.test(text);
  }
  return /(?:who\s+is|best\s+suited|suitable\s+for|recommended\s+for|which\s+skin\s+types?|what\s+skin\s+types?)/iu.test(text);
}

function isDirectIngredientBenefitFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(question);
  if (locale === "ko-KR") {
    return /(?:주요|핵심)\s*(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:효능|효과)|(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:효능|효과)[^?？.。!！]{0,20}(?:무엇|뭔가요|있나요)/u.test(text);
  }
  return /\b(?:key|main|primary)\s+(?:ingredients?|formula|technolog(?:y|ies))\b[^?!.]{0,60}\b(?:benefits?|effects?)\b|\b(?:ingredients?|formula|technolog(?:y|ies))\b[^?!.]{0,60}\b(?:benefits?|effects?)\b/i.test(text);
}

function isGenericBenefitOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(question);
  if (locale === "ko-KR") {
    return /(?:어떤\s*)?피부\s*고민(?:과|및)?\s*효능|피부\s*고민과\s*효능/u.test(text)
      && !isDirectIngredientBenefitFaqQuestion(text, locale);
  }
  return /\bskin\s+concerns?\s+(?:and|&)\s+(?:benefits?|effects?)\b|\b(?:benefits?|effects?)\s+and\s+skin\s+concerns?\b/i.test(text)
    && !isDirectIngredientBenefitFaqQuestion(text, locale);
}

function isTargetConcernEffectSuitabilityFaq(item: PdpGeoFaqItem, locale: PdpGeoLocale): boolean {
  const question = cleanSignal(item.question);
  const combined = cleanSignal(`${item.question} ${item.answer}`);
  if (!question || isDirectIngredientBenefitFaqQuestion(question, locale)) {
    return false;
  }
  const targetIntent = locale === "ko-KR"
    ? /(?:누구|어떤\s*(?:고객|피부|대상)|추천|적합|고객에게|피부\s*고민|고민에\s*(?:도움|맞|적합)|어떤\s*(?:세럼|크림|제품)[^?？]{0,50}(?:도움|효과|지원))/u.test(question)
    : /(?:who\s+is|best\s+suited|suitable\s+for|recommended\s+for|customers?|people\s+with|which\s+(?:serum|cream|product)[^?!.]{0,70}(?:supports?|helps?|addresses?))/iu.test(question);
  const concern = /(?:고민|건조|민감|장벽|수분|보습|탄력|주름|피부결|concern|dry|sensitive|barrier|hydrat|moistur|firm|wrinkle|texture)/iu.test(combined);
  const effect = /(?:효능|효과|도움|지원|개선|보습|수분|benefit|effect|help|support|address|improv|hydrat|moistur)/iu.test(combined);
  return targetIntent && concern && effect;
}

function isLowQualityFaqItem(item: PdpGeoFaqItem): boolean {
  const combined = `${item.question} ${item.answer}`;
  return isLowQualityPublicEvidenceText(combined)
    || hasFaqCitationNoise(combined)
    || item.answer.length < 12
    || item.answer.length > 620
    || isQuestionLikeText(item.answer)
    || isBrokenMarketingFragment(item.answer)
    || isNonAnswerLeadFaqAnswer(item.answer);
}

/** Public FAQ answers must not open with a cannot-confirm non-answer sentence. */
function isNonAnswerLeadFaqAnswer(answer: string): boolean {
  const lead = answer.split(/(?<=[.。!?？])\s+/)[0] ?? answer;
  return /(확인하기\s*어렵|확인이\s*어렵|확인되지\s*않|확인할\s*수\s*없|알\s*수\s*없|알기\s*어렵|판단하기\s*어렵|정보만으로는|정보가\s*없|공개되지\s*않|미공개입니다|cannot\s+be\s+(?:confirmed|verified|determined)|is\s+unclear|is\s+not\s+(?:confirmed|specified|available)|no\s+information\s+is\s+available)/i.test(lead);
}

function isReviewBasedFaqCandidate(item: PdpGeoFaqItem, locale: PdpGeoLocale): boolean {
  const question = cleanSignal(item.question);
  const answer = cleanSignal(item.answer);
  if (!question || !answer) {
    return false;
  }
  const combined = `${question} ${answer}`;
  if (locale === "ko-KR" && isRawReviewLikeKoreanFaqCandidateQuestion(question) && isNegativeReviewSignalText(combined)) {
    return true;
  }
  if (isExplicitReviewFaqCandidateQuestion(question) && isNegativeReviewSignalText(answer)) {
    return true;
  }
  return /^(?:고객\s*리뷰|대표\s*고객\s*리뷰|리뷰에서는|후기에서는|Customer\s+reviews?|Reviews?|Representative\s+customer\s+reviews?|レビュー|口コミ)/iu.test(answer)
    && isNegativeReviewSignalText(answer);
}

function isExplicitReviewFaqCandidateQuestion(value: string): boolean {
  return /(?:고객\s*리뷰|리뷰|후기|평점|customer\s+reviews?|what\s+do\s+customer\s+reviews|reviews?\s+(?:highlight|mention|describe|repeat)|レビュー|口コミ)/iu.test(value);
}

function isRawReviewLikeKoreanFaqCandidateQuestion(value: string): boolean {
  const text = cleanSignal(value)
    .replace(/[?？!！.。]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[가-힣]/u.test(text)) {
    return false;
  }
  if (/^(?:\d(?:\.\d)?\s+){1,2}[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text)) {
    return true;
  }
  const hasReviewVoice = /(?:뽀득거리지도|미끌거리지도|무난하게|데일리로\s*사용|트러블\s*올라오지|성분이\s*착해서|약품\s*냄새|약품냄새|냄새|향이|아쉬운|좋아요|좋네요|좋은\s*것\s*같|같아요|같구요|같네요|더라구|더라고|구요|했어요|써봤|구매했|사용중|느낌)$/u.test(text)
    || /(?:뽀득|미끌|촉촉|당김|크리미|거품|순해서|자극없이|데일리|무난|트러블|아쉬운|냄새|향이|좋아요|같아요|느낌)/u.test(text);
  if (!hasReviewVoice) {
    return false;
  }
  const hasQuestionForm = /(?:인가요|나요|까요|어떤가요|무엇인가요|맞나요|좋나요|괜찮나요|가능한가요|있나요|되나요|하나요|추천할\s*수\s*있나요|사용할\s*수\s*있나요)\s*[?？]?$/u.test(text);
  const isOverlongReview = text.length >= 55 || text.split(/\s+/).length >= 9;
  const hasMultipleReviewClauses = (text.match(/(?:좋아요|같아요|아쉬운|느낌|냄새|트러블|데일리|무난)/gu) ?? []).length >= 2;
  return !hasQuestionForm || isOverlongReview || hasMultipleReviewClauses;
}

function hasProductSpecificFaqQualityIssue(item: PdpGeoFaqItem, product: PdpProductSignal): boolean {
  const combined = cleanSignal(`${item.question} ${item.answer}`);
  if (/입니다는|습니다는|자생력이를|결과\s+결과/.test(combined)) {
    return true;
  }
  const productContext = cleanSignal([
    product.name,
    product.originalName,
    product.category,
    inferProductType(product)
  ].filter(Boolean).join(" "));
  const isCleanserProduct = /(?:클렌|세안|폼|워시|cleanser|cleansing|foam|wash)/i.test(productContext);
  return /(?:저자극\s*세안|세정력|초미세먼지\s*세정|모공\s*속\s*노폐물\s*세정|마이크로\s*버블)/.test(combined) && !isCleanserProduct;
}

function isFaqQuestionAnswerAligned(
  item: PdpGeoFaqItem,
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  sourceBacked: boolean
): boolean {
  const question = cleanSignal(item.question);
  const answer = cleanSignal(item.answer);
  const combined = `${question} ${answer}`;
  if (hasFaqCitationNoise(combined)) {
    return false;
  }
  if (!isFaqAnswerAlignedToQuestion(question, answer)) {
    return false;
  }

  if (/(?:정보는\s*어떤\s*근거|어떤\s*근거로\s*확인|what\s+evidence\s+supports|which\s+evidence\s+supports)/i.test(question)) {
    return hasExternalAuthorityEvidenceSignal(product, answer);
  }

  if (/(?:어떤\s*고객|누구에게|추천|who\s+is|best\s+suited|suitable\s+for|recommend)/i.test(question)) {
    const targetAnswer = /(?:고객|피부|여성|남성|연령|대상|고민|주름|탄력|노화|건조|민감|장벽|수분|customers?|women|men|aged|participants?|skin|concern|wrinkles?|firm|aging|ageing|dry|sensitive|barrier|hydration)/i.test(answer);
    if (!targetAnswer) {
      return false;
    }
  }

  if (/(?:성분|기술|ingredient|technology|formula)/i.test(question)
    && /(?:상품\s*상세\s*테스트|확인\s*지표[^.!?。！？]{0,80}성분\s*설명|성분\s*설명입니다)/i.test(answer)) {
    return false;
  }

  if (!sourceBacked && locale === "ko-KR" && /(?:확인\s*키워드|선택\s*이유를\s*구체화|체감\s*맥락을\s*보완)/.test(answer)) {
    return false;
  }

  return true;
}

function hasFaqCitationNoise(value: string | undefined): boolean {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return false;
  }
  return /(?:NEW\s*\||\|\s*(?:cream|serum)|상품\s*상세\s*테스트|확인\s*키워드|결과\s*성분\s*설명입니다|성분\s*설명입니다|확인\s*근거를\s*정리|확인\s*근거에는|정보를\s*정리합니다)/i.test(text);
}

function hasExternalAuthorityEvidenceSignal(product: PdpProductSignal, evidence: string | undefined): boolean {
  const text = cleanSignal([
    evidence,
    product.description,
    ...product.metrics,
    ...product.sourceTexts,
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ].filter(Boolean).join(" "));
  if (!text || isCommerceMetricArtifact(text)) {
    return false;
  }
  return /(?:https?:\/\/(?:doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|clinicaltrials\.gov|www\.ncbi\.nlm\.nih\.gov)|\bdoi\s*[:/]|PMID|PubMed|ClinicalTrials\.gov|논문|학술지|저널|학술\s*자료|연구\s*논문|기사|보도자료|전문지|journal|peer[-\s]?reviewed|published\s+(?:study|paper|article)|research\s+(?:paper|article)|news\s+article|press\s+release)/i.test(text);
}

function scoreFaqCandidateForCitation(
  item: PdpGeoFaqItem,
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  sourceBacked: boolean
): number {
  const combined = cleanSignal(`${item.question} ${item.answer}`);
  let score = sourceBacked ? 28 : 0;
  score += scoreFaqBuyerDecisionIntent(item);
  if (containsEntityToken(combined, productName) || product.brand && containsEntityToken(combined, product.brand)) {
    score += 8;
  }
  if (item.answer.length >= 40 && item.answer.length <= 360) {
    score += 6;
  }
  if (item.answer.length < 32) {
    score -= 18;
  }
  if (/[0-9０-９]/.test(item.answer)) {
    score += 4;
  }
  if (/(?:\d+(?:\.\d+)?\s*%|\d+\s*(?:시간|일|주|명|회|hours?|days?|weeks?|participants?))/.test(item.answer)) {
    score += 12;
  }
  if (/(?:성분|기술|포뮬러|ingredient|formula|technology|complex|peptide|extract|vitamin|ceramide|hyaluronic)/i.test(combined)) {
    score += 5;
  }
  if (/(?:효능|케어|보습|수분|탄력|주름|피부결|진정|benefit|hydration|firming|wrinkle|texture|soothing)/i.test(combined)) {
    score += 5;
  }
  if (/(?:사용|루틴|아침|저녁|단계|apply|use|routine|morning|night)/i.test(combined)) {
    score += 4;
  }
  if (/(?:리뷰|고객|후기|review|customer|rating)/i.test(combined) && !isNegativeReviewSignalText(combined)) {
    score += 3;
  }
  if (/(?:옵션|용량|가격|버전|option|size|price|variant|version)/i.test(combined)) {
    score += 3;
  }
  if (isLowQualityIngredientEvidenceText(combined)) {
    score -= 60;
  }
  if (isCommercePolicyText(combined) && !hasCareOrFormulaSignal(combined)) {
    score -= 40;
  }
  if (locale === "ko-KR" && isKoreanMetaNarrationText(combined)) {
    score -= sourceBacked ? 3 : 10;
  }
  if ((locale === "en-US" || locale === "en-GB") && isEnglishMetaNarrationText(combined)) {
    score -= sourceBacked ? 6 : 14;
  }
  if (hasKoreanSurfaceQualityIssue(combined) || hasEnglishSurfaceQualityIssue(combined)) {
    score -= 40;
  }
  return score;
}

function scoreFaqBuyerDecisionIntent(item: PdpGeoFaqItem): number {
  const question = cleanSignal(item.question);
  const combined = cleanSignal(`${item.question} ${item.answer}`);
  let score = 0;
  if (isDirectIngredientBenefitFaqQuestion(question, /[가-힣]/u.test(question) ? "ko-KR" : "en-US")) score += 36;
  if (isGenericBenefitOverviewFaqQuestion(question, /[가-힣]/u.test(question) ? "ko-KR" : "en-US")) score += 24;
  if (/(?:누구|어떤\s*(?:고객|피부|대상)|추천\s*(?:대상|고객)|적합|피부\s*타입|who\s+is|who\s+should|best\s+suited|suitable|skin\s*type|どんな.*(?:人|肌)|誰|向いて)/iu.test(question)) score += 90;
  if (/(?:고민|손상|민감|건조|장벽|주름|탄력|concern|damaged|sensitive|dry|barrier|wrinkle|firm|悩み|敏感|乾燥|バリア)/iu.test(question)
    && /(?:고객|피부|customers?|skin|方|肌)/iu.test(question)
    && /(?:효능|효과|도움|benefits?|effects?|help|support|効果)/iu.test(question)) score += 90;
  if (/(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(question)
    && /(?:사용|쓸\s*수|가능|use|suitable|使用|使え)/iu.test(question)) score += 140;
  if (/(?:피부|건조|민감|예민|당김|장벽|주름|탄력|skin|dry|sensitive|barrier|wrinkle|firm|肌|乾燥|敏感|バリア)[^?？]{0,80}(?:때|경우|when|if|とき|場合)[^?？]{0,60}(?:어떤|무엇|which|what|どの|何)[^?？]{0,40}(?:선택|추천|choose|select|recommend|選)/iu.test(question)) score += 50;
  if (/(?:효능|효과|장점|어떤\s*피부\s*고민|benefits?|effects?|skin\s*concerns?|効果|肌悩み)/iu.test(question)) score += 14;
  if (/(?:성분|기술|포뮬러|ingredient|technology|formula|成分|技術)/iu.test(question)
    && /(?:효능|효과|도움|개선|보습|장벽|진정|benefit|effect|help|support|improv|hydration|barrier|効果|改善|保湿)/iu.test(combined)) score += 18;
  if (/(?:건조|당김|민감|예민|장벽|트러블|주름|탄력|피부결|피지|유분|dry|sensitive|barrier|wrinkle|firm|texture|oil|sebum|乾燥|敏感|バリア|しわ)/iu.test(question)) score += 10;
  if (/(?:리뷰|후기|시험|테스트|임상|근거|수치|review|test|clinical|evidence|metric|レビュー|試験)/iu.test(question)) score += 8;
  if (/(?:옵션|용량|사이즈|가격|본품|소용량|리필|버전|option|size|price|full[-\s]?size|mini|refill|variant|容量|価格|本品|ミニ|リフィル)/iu.test(question)) score += 14;
  if (/(?:보관|배송|교환|반품|쿠폰|적립|storage|shipping|delivery|return|refund|coupon|保管|配送|返品)/iu.test(question)) score -= 20;
  return score;
}

function normalizeFaqQuestionKey(question: string): string {
  return cleanSignal(question)
    .toLocaleLowerCase()
    .replace(/[?？!.。！？]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function selectSourceFaqForPublicUse(
  faq: PdpGeoFaqItem[],
  locale: PdpGeoLocale,
  productName: string,
  structuredClaimEvidence: string[] = []
): PdpGeoFaqItem[] {
  return faq.flatMap((item) => {
    if (!isRawSourceFaqPairUsable(item)) {
      return [];
    }
    const sourceQuestion = normalizeInferencePublicText(item.question, locale);
    const directAnswer = normalizeFaqAnswerForDirectVoice(item.answer, locale, productName);
    const question = rewriteSourceFaqQuestionForBuyerConcern(sourceQuestion, directAnswer, locale, productName);
    const answer = question !== sourceQuestion
      ? appendFaqRecommendationContext(directAnswer, locale)
      : directAnswer;
    if (!question || !answer
      || !isFaqLocaleCompatible({ question, answer }, locale, [productName])
      || !isUsefulSourceFaqQuestion(question, answer, locale, productName)
      || !isUsefulSourceFaqAnswer(answer, locale)
      || !isFaqStructuredClaimSupported(answer, structuredClaimEvidence)) {
      return [];
    }
    return [{ question, answer: locale === "ko-KR" ? answer : trimTrailingSentencePunctuation(answer) }];
  }).slice(0, 12);
}

function faqStructuredClaimEvidence(product: PdpProductSignal): string[] {
  return unique([
    ...product.metrics,
    ...product.options,
    ...(product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [
      claim.value,
      claim.period,
      claim.timing,
      claim.sentence,
      claim.sourceText
    ].filter((value): value is string => Boolean(value)))
  ]);
}

function isFaqStructuredClaimSupported(answer: string, structuredEvidence: string[]): boolean {
  const claims = unique(Array.from(cleanSignal(answer).matchAll(/\b\d+(?:\.\d+)?\s*(?:%|weeks?|days?|hours?|ml|oz|주|일|시간)(?=\s|$|[.,;:)])/gi))
    .map((match) => normalizeFaqClaimToken(match[0] ?? ""))
    .filter(Boolean));
  if (claims.length === 0) {
    return true;
  }
  const evidence = structuredEvidence.map(normalizeFaqClaimToken).join(" ");
  return claims.every((claim) => evidence.includes(claim));
}

function normalizeFaqClaimToken(value: string): string {
  return cleanSignal(value).toLocaleLowerCase().replace(/\s+/g, " ").replace(/\bweek\b/g, "weeks").replace(/\bday\b/g, "days").replace(/\bhour\b/g, "hours");
}

function isRawSourceFaqPairUsable(item: PdpGeoFaqItem): boolean {
  const question = cleanSignal(item.question);
  const answer = cleanSignal(item.answer);
  if (!question || !answer || /\b1\s+(?:weeks|days|hours)\b/i.test(answer) || /["']\s*$/.test(answer)) {
    return false;
  }
  return !/\b(?:among\s+the\s+)?best\b[^.!?]{0,100}\b(?:available|in\s+20\d{2}|on\s+the\s+market)\b/i.test(answer);
}

function normalizeFaqAnswerForDirectVoice(value: string, locale: PdpGeoLocale, productName: string): string {
  let text = normalizeInferencePublicText(value, locale);
  if (locale === "ko-KR") {
    text = text
      .replace(/^(?:(?:제품|상품)(?:\s*(?:페이지|정보))?\s*)?FAQ(?:에서는|에\s*따르면|가이드에서는)\s*/u, "")
      .replace(/^(?:제품|상품)\s*(?:설명|정보|자료)(?:에서는|에\s*따르면)\s*/u, "")
      .replace(/사용\s*가능한\s*제품이라고\s*(?:설명|안내)합니다/gu, "사용할 수 있습니다")
      .replace(/사용할\s*수\s*있다고\s*(?:설명|안내)합니다/gu, "사용할 수 있습니다")
      .replace(/제공한다고\s*(?:설명|안내)합니다/gu, "제공합니다")
      .replace(/도와준다고\s*(?:설명|안내)합니다/gu, "도와줍니다")
      .replace(/돕는다고\s*(?:설명|안내)합니다/gu, "돕습니다")
      .replace(/강화해\s*준다고\s*(?:설명|안내)합니다/gu, "강화해 줍니다")
      .replace(/된다고\s*(?:설명|안내)합니다/gu, "됩니다")
      .replace(/있다고\s*(?:설명|안내)합니다/gu, "있습니다")
      .replace(/없다고\s*(?:설명|안내)합니다/gu, "없습니다")
      .replace(/한다고\s*(?:설명|안내)합니다/gu, "합니다")
      .replace(/라고\s*(?:설명|안내)합니다/gu, "입니다")
      .replace(/제공해\s*준다고\s*확인할\s*수\s*있습니다/gu, "제공합니다")
      .replace(/도와\s*준다고\s*확인할\s*수\s*있습니다/gu, "도와줍니다")
      .replace(/된다고\s*확인할\s*수\s*있습니다/gu, "됩니다")
      .replace(/있다고\s*확인할\s*수\s*있습니다/gu, "있습니다")
      .replace(/없다고\s*확인할\s*수\s*있습니다/gu, "없습니다")
      .replace(/함유되어\s*있지\s*않다고\s*확인할\s*수\s*있습니다/gu, "함유되어 있지 않습니다")
      .replace(/한다고\s*확인할\s*수\s*있습니다/gu, "합니다")
      .replace(/누구나\s*사용\s*가능한\s*제품이라고\s*확인할\s*수\s*있습니다/gu, "누구나 사용할 수 있습니다")
      .replace(/제품(?:이)?라고\s*확인할\s*수\s*있습니다/gu, "제품입니다")
      .replace(/제품으로\s*확인할\s*수\s*있습니다/gu, "제품입니다")
      .replace(/(?:설명|안내)되어\s*있습니다/gu, "확인할 수 있습니다");
    const escapedName = escapeRegExp(productName);
    if (escapedName) {
      text = text.replace(new RegExp(`^${escapedName}(?:이|가)\\s+`, "u"), `${appendKoreanTopicParticle(productName)} `);
    }
    text = text
      .replace(/^제품은\s+/u, `${appendKoreanTopicParticle(productName)} `)
      .replace(/^제품에는\s+/u, `${productName}에는 `)
      .replace(/^제품에\s+/u, `${productName}에 `);
    return normalizeInferencePublicText(text, locale);
  }
  if (locale === "ja-JP") {
    return text
      .replace(/^(?:商品|製品)(?:ページ)?の?FAQ(?:では|によると)[、,]?\s*/u, "")
      .replace(/と(?:説明|案内)されています/u, "です");
  }
  return text
    .replace(/^(?:according\s+to\s+)?(?:the\s+)?(?:product\s+)?FAQ(?:\s+says|\s+states|,)?\s*(?:that\s+)?/i, "")
    .replace(/^(?:the\s+)?product\s+(?:page|information|materials?)\s+(?:says|states|explains)\s+that\s+/i, "");
}

function rewriteSourceFaqQuestionForBuyerConcern(
  question: string,
  answer: string,
  locale: PdpGeoLocale,
  productName: string
): string {
  if ((locale === "en-US" || locale === "en-GB")
    && /\b(?:all|every)\s+skin\s+types?\b/i.test(question)
    && /\bmost\s+skin\s+types?\b/i.test(answer)) {
    return `Which skin types is ${productName} suitable for?`;
  }
  if (locale === "ko-KR"
    && /모든\s*피부\s*타입/u.test(question)
    && /대부분의?\s*피부\s*타입/u.test(answer)) {
    return `${appendKoreanTopicParticle(productName)} 어떤 피부 타입에 적합한가요?`;
  }
  if (locale !== "ko-KR" || !/(?:효능|효과|도움|추천|적합)/u.test(question)) {
    return question;
  }
  const concern = inferKoreanFaqCustomerConcern(`${question} ${answer}`);
  if (!concern) {
    return question;
  }
  return `${appendKoreanSubjectParticle(concern)} 고민인 고객에게 ${appendKoreanTopicParticle(productName)} 어떤 효과가 있나요?`;
}

function inferKoreanFaqCustomerConcern(value: string): string | undefined {
  const text = normalizeInferencePublicText(value, "ko-KR");
  if (/손상된\s*피부\s*장벽/u.test(text)) return "손상된 피부 장벽";
  if (/피부\s*장벽\s*약화/u.test(text)) return "피부 장벽 약화";
  const explicit = text.match(/((?:외부\s*자극|유해\s*환경)[^,.!?。！？]{0,55}(?:민감해(?:지거나|지고|진)?\s*)?(?:손상된\s*)?피부\s*장벽)/u)?.[1];
  if (explicit && explicit.length <= 80) {
    return trimTrailingSentencePunctuation(explicit);
  }
  const hasBarrier = /(?:피부\s*장벽|장벽\s*약화|장벽\s*손상)/u.test(text);
  const hasSensitive = /(?:민감|예민|자극)/u.test(text);
  const hasDry = /(?:건조|당김|보습|수분\s*부족)/u.test(text);
  const hasAging = /(?:주름|탄력\s*저하|노화)/u.test(text);
  if (hasBarrier && hasSensitive) return "민감해지고 손상된 피부 장벽";
  if (hasBarrier && hasDry) return "건조함과 피부 장벽 약화";
  if (hasAging) return "주름과 탄력 저하";
  if (hasSensitive) return "민감한 피부";
  if (hasDry) return "건조한 피부";
  return undefined;
}

function appendFaqRecommendationContext(answer: string, locale: PdpGeoLocale): string {
  if (!answer || /(?:추천할\s*수\s*있|recommended|suited|向いて)/i.test(answer)) {
    return answer;
  }
  let benefitTerms = unique(extractCanonicalBenefitTerms(answer)
    .map((term) => localizePublicBenefitSignal(term, locale))
    .filter((term): term is string => Boolean(term)))
    .slice(0, 2);
  if (locale === "ko-KR") {
    const directEffectTerms = unique([
      /진정/u.test(answer) ? "진정" : undefined,
      /보습|수분/u.test(answer) ? "보습" : undefined,
      /피부\s*장벽/u.test(answer) ? "피부 장벽 케어" : undefined,
      /탄력/u.test(answer) ? "탄력 케어" : undefined,
      /주름/u.test(answer) ? "주름 케어" : undefined
    ].filter((term): term is string => Boolean(term))).slice(0, 2);
    if (directEffectTerms.length > 0) {
      benefitTerms = directEffectTerms;
    }
  }
  const benefits = formatDescriptionList(unique(benefitTerms).slice(0, 2), locale, 2);
  if (!benefits) {
    return answer;
  }
  if (locale === "ko-KR") {
    const naturalBenefits = formatKoreanListForSentence(benefits);
    return compactSentence([answer, `따라서 ${appendKoreanObjectParticle(naturalBenefits)} 원하는 고객에게 추천할 수 있습니다`]);
  }
  if (locale === "ja-JP") {
    return compactSentence([answer, `そのため、${benefits}を求める方に向いています`]);
  }
  return compactSentence([answer, `It is therefore suited to customers looking for ${benefits}`]);
}

function removeMisroutedReviewContextFromFaqAnswer(question: string, answer: string, locale: PdpGeoLocale): string {
  if (isExplicitReviewFaqCandidateQuestion(question)) {
    return answer;
  }
  const reviewFrame = locale === "ko-KR"
    ? /^(?:고객\s*)?(?:리뷰|후기)에서는|^리뷰\s*표현/u
    : locale === "ja-JP"
      ? /^(?:レビュー|口コミ)(?:では|によると)/u
      : /^(?:customer\s+)?reviews?\s+(?:mention|repeat|highlight|describe|report)|^according\s+to\s+(?:customer\s+)?reviews?/iu;
  return answer
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !reviewFrame.test(sentence))
    .join(" ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsefulSourceFaqQuestion(value: string, answer: string, locale: PdpGeoLocale, productName: string): boolean {
  const text = cleanSignal(value);
  if (text.length < 6 || text.length > 180 || isSectionHeadingFaqQuestion(text) || isBrokenMarketingFragment(text)) {
    return false;
  }
  if (!isFaqAnswerAlignedToQuestion(text, answer)) {
    return false;
  }
  const productSpecific = containsEntityToken(`${text} ${answer}`, productName);
  if ((locale === "en-US" || locale === "en-GB") && !productSpecific && text.length < 28 && answer.length < 80) {
    return false;
  }
  return !/(?:GEO|RAG|schema optimization|citation-ready|field contract|OCR|image caption)/i.test(text);
}

function isFaqAnswerAlignedToQuestion(question: string, answer: string): boolean {
  const normalizedQuestion = cleanSignal(question);
  const normalizedAnswer = cleanSignal(answer);
  const asksForEffect = /(?:효능|효과|어떤\s*도움|benefits?|effects?|what\s+does[^?]{0,40}do|how\s+does[^?]{0,40}help|効果)/iu.test(normalizedQuestion);
  const answersWithEffect = /(?:보습|수분|장벽|진정|탄력|주름|피부결|광채|세정|개선|강화|완화|지속|증가|감소|도움|케어|hydration|moisture|barrier|sooth|firm|elastic|wrinkle|texture|radiance|cleanse|improv|strengthen|reduc|increase|decrease|support|care|保湿|バリア|ハリ|しわ|改善|効果|サポート)/iu.test(normalizedAnswer)
    || /\d+(?:\.\d+)?\s*(?:%|배)/u.test(normalizedAnswer);
  if (asksForEffect && !answersWithEffect) {
    return false;
  }
  const asksLifeStageSuitability = /(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(normalizedQuestion)
    && /(?:사용|써도|가능|use|suitable|使用|使え)/iu.test(normalizedQuestion);
  const directlyAnswersLifeStage = /(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠|0\s*세|생후|성인까지|사용할\s*수|사용\s*가능|권장하지|피하|국소\s*부위|패치\s*테스트|전문의|can\s+be\s+used|safe\s+for|not\s+recommended|avoid|patch\s+test|consult)/iu.test(normalizedAnswer);
  if (asksLifeStageSuitability && !directlyAnswersLifeStage) {
    return false;
  }
  const asksSymptomUseSuitability = /(?:따가|따끔|자극|붉|가려|트러블|irritat|sting|redness|itch)[^?？]{0,80}(?:사용|써도|괜찮|use|suitable)/iu.test(normalizedQuestion)
    || /(?:사용|써도|괜찮|use|suitable)[^?？]{0,80}(?:따가|따끔|자극|붉|가려|트러블|irritat|sting|redness|itch)/iu.test(normalizedQuestion);
  const directlyAnswersSymptomUse = /(?:사용할\s*수|사용\s*가능|권장|피하|중지|국소\s*부위|패치\s*테스트|전문의|상담|can\s+be\s+used|safe\s+for|recommend|avoid|stop\s+use|patch\s+test|consult)/iu.test(normalizedAnswer);
  if (asksSymptomUseSuitability && !directlyAnswersSymptomUse) {
    return false;
  }
  const asksUsageTiming = /(?:세안|토너|세럼|크림|메이크업|선크림|moisturi[sz]er|clean(?:s|se)|toner|serum|makeup|sunscreen)[^?？]{0,70}(?:후|전|바로|언제|순서|before|after|immediately)[^?？]{0,50}(?:사용|바르|apply|use)/iu.test(normalizedQuestion)
    || /(?:사용|바르|apply|use)[^?？]{0,50}(?:세안|토너|세럼|크림|메이크업|선크림|moisturi[sz]er|clean(?:s|se)|toner|serum|makeup|sunscreen)[^?？]{0,70}(?:후|전|바로|언제|순서|before|after|immediately)/iu.test(normalizedQuestion);
  const directlyAnswersUsageTiming = /(?:세안|토너|세럼|크림|메이크업|선크림|moisturi[sz]er|clean(?:s|se)|toner|serum|makeup|sunscreen|아침|저녁|morning|night)[^.!?。！？]{0,80}(?:후|전|다음|바로|단계|before|after|then|step)|(?:사용|바르|도포|apply|use)[^.!?。！？]{0,80}(?:후|전|다음|단계|before|after|then|step)/iu.test(normalizedAnswer);
  if (asksUsageTiming && !directlyAnswersUsageTiming) {
    return false;
  }
  if (/\b(?:all|every)\s+skin\s+types?\b/i.test(normalizedQuestion)
    && /\bmost\s+skin\s+types?\b/i.test(normalizedAnswer)) {
    return false;
  }
  if (/(?:차이|비교|다른가|동일|difference|compare|versus|\bvs\.?\b|same|different)/i.test(normalizedQuestion)
    && !/(?:차이|비교|반면|보다|동일|같|다르|각각|whereas|while|compared|same|different|both)/i.test(normalizedAnswer)) {
    return false;
  }
  if (/(?:모공|막히|논코메도|clog(?:ged|ging)?\s+pores?|comedogenic)/i.test(normalizedQuestion)
    && !/(?:모공|막히|논코메도|여드름|clog(?:ged|ging)?\s+pores?|comedogenic)/i.test(normalizedAnswer)) {
    return false;
  }
  if (/(?:여드름|지성|acne|oily\s+skin)/i.test(normalizedQuestion)
    && !/(?:여드름|지성|피지|유분|논코메도|acne|oily\s+skin|sebum|oil|comedogenic)/i.test(normalizedAnswer)) {
    return false;
  }
  return true;
}

function isUsefulSourceFaqAnswer(value: string, _locale: PdpGeoLocale): boolean {
  const text = cleanSignal(value);
  if (text.length < 12 || text.length > 520 || isQuestionLikeText(text) || isBrokenMarketingFragment(text) || isNonCitationEvidenceArtifact(text) || isLowQualityPublicEvidenceText(text)) {
    return false;
  }
  if (/\b1\s+(?:weeks|days|hours)\b/i.test(text)
    || /["']\s*$/.test(text)
    || /\b(?:among\s+the\s+)?best\b[^.!?]{0,100}\b(?:available|in\s+20\d{2}|on\s+the\s+market)\b/i.test(text)) {
    return false;
  }
  return !/(?:GEO|RAG|schema optimization|citation-ready|field contract|OCR|image caption|product shot|pack shot)/i.test(text);
}

function createTextureFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  textureFinish: string,
  _benefit: string | undefined
): string {
  if (locale === "ko-KR") {
    const texturePhrase = /(?:사용감|마무리|제형|텍스처)$/u.test(textureFinish)
      ? textureFinish
      : `${textureFinish} 사용감`;
    return compactSentence([
      `${appendKoreanTopicParticle(productName)} ${appendKoreanSubjectParticle(texturePhrase)} 특징입니다`
    ]);
  }
  const textureSentence = /(?:texture|finish|feel)(?:\b|,)/i.test(textureFinish)
    ? `${productName} is described with ${textureFinish}`
    : `${productName} has a ${textureFinish} texture or finish`;
  return compactSentence([textureSentence]);
}

function createRoutineSynergyFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  routineSynergy: string,
  optimizedUsage: string | undefined,
  _ingredient: string | undefined
): string {
  if (optimizedUsage) {
    const usageContext = localizedUsageRoutineContext(locale, productName, optimizedUsage);
    if (locale === "ko-KR") {
      return compactSentence([
        `${appendKoreanTopicParticle(productName)} ${routineSynergy}`,
        usageContext
      ]);
    }
    return compactSentence([
      `${productName} fits ${routineSynergy}`,
      usageContext
    ]);
  }
  if (locale === "ko-KR") {
    return compactSentence([`${appendKoreanTopicParticle(productName)} ${routineSynergy}`]);
  }
  return compactSentence([`${productName} fits ${routineSynergy}`]);
}

function createVariantComparisonFaqAnswer(locale: PdpGeoLocale, productName: string, variantComparison: string): string {
  if (locale === "ko-KR") {
    return `${appendKoreanTopicParticle(productName)} ${variantComparison} 기준으로 비교하면 됩니다. 옵션명, 용량, 제형, 가격 정보가 함께 제공될 때 현재 페이지의 상품 정보를 기준으로 선택할 수 있습니다.`;
  }
  return `${productName} can be compared by ${variantComparison}. When option name, size, texture, and price are available, those details help shoppers choose the matching variant.`;
}

function selectTextureFinishSignal(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  const reviewKeywords = selectPublicReviewKeywords(product, locale).join(" ");
  const combined = `${text} ${reviewKeywords}`;
  const koSignals = [
    /산뜻(?:한)?\s*고밀도\s*텍스처/.test(combined) ? "산뜻한 고밀도 텍스처" : undefined,
    /리치(?:한)?\s*(?:제형|텍스처|사용감|크림감)/.test(combined) ? "리치한 제형" : undefined,
    /쫀쫀(?:한)?\s*(?:제형|텍스처|사용감)/.test(combined) ? "쫀쫀한 사용감" : undefined,
    /촉촉(?:한)?\s*(?:사용감|마무리|제형|텍스처)/.test(combined) ? "촉촉한 사용감" : undefined,
    /부드러(?:운|움)\s*(?:사용감|마무리|제형|텍스처)/.test(combined) ? "부드러운 사용감" : undefined,
    /흡수감/.test(combined) ? "흡수감" : undefined,
    /끈적임\s*없|non[-\s]?sticky/i.test(combined) ? "끈적임이 적은 마무리" : undefined
  ].filter((value): value is string => Boolean(value));
  if (locale === "ko-KR" && koSignals.length > 0) {
    return formatDescriptionList(unique(koSignals), locale, 3);
  }

  const enSignals = [
    /rich\s+(?:texture|cream|finish)/i.test(combined) ? "rich texture" : undefined,
    /lightweight|light\s+texture/i.test(combined) ? "lightweight texture" : undefined,
    /non[-\s]?sticky/i.test(combined) ? "non-sticky finish" : undefined,
    /smooth(?:ing)?\s+(?:texture|finish|feel)/i.test(combined) ? "smooth finish" : undefined,
    /absorbs?\s+(?:quickly|well)|absorption/i.test(combined) ? "comfortable absorption" : undefined,
    /moist(?:urizing|urising)?\s+(?:finish|feel)|hydrating\s+(?:finish|feel)/i.test(combined) ? "moisturizing feel" : undefined
  ].filter((value): value is string => Boolean(value));
  return enSignals.length > 0 ? formatDescriptionList(unique(enSignals), locale, 3) : undefined;
}

function selectRoutineSynergySignal(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  if (locale === "ko-KR") {
    if (/(?:세럼|앰플|에센스|토너|크림|스킨케어)\s*(?:후|다음|전|함께|단계|루틴)|(?:함께|같이)\s*(?:사용|레이어링)/.test(text)) {
      return "세럼, 앰플, 에센스 등 스킨케어 루틴 단계와 함께 사용할 수 있습니다";
    }
    if (/(?:아침|저녁|매일|데일리|밤)\s*(?:사용|루틴|케어)/.test(text)) {
      return "아침 또는 저녁 스킨케어 루틴에서 사용할 수 있습니다";
    }
    return undefined;
  }
  if (/\b(?:serum|ampoule|essence|toner|cream|skincare)\b.{0,40}\b(?:after|before|with|routine|layer|step)\b|\b(?:after|before|with)\b.{0,40}\b(?:serum|ampoule|essence|toner)\b/i.test(text)) {
    return "a serum, essence, toner, or skincare layering routine";
  }
  if (/\b(?:morning|night|daily|evening)\b.{0,40}\b(?:use|routine|care)\b/i.test(text)) {
    return "a morning or evening skincare routine";
  }
  return undefined;
}

function selectVariantComparisonSignal(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  const optionSummary = summarizeVariantOptions(product, locale);
  if (optionSummary) {
    return optionSummary;
  }
  if (/(?:차이|비교|버전|옵션|제형|용량|difference|compare|version|variant|option|texture|size)/i.test(text) && product.options.length > 1) {
    return fallback(locale, {
      "ko-KR": "옵션명, 용량, 가격",
      "ja-JP": "オプション名、容量、価格",
      "en-US": "option name, size, and price",
      "en-GB": "option name, size, and price"
    });
  }
  return undefined;
}

function summarizeVariantOptions(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const variants = unique(product.options.flatMap((option) => {
    const text = cleanSignal(option).replace(/\[[^\]]{1,36}\]/g, (match) => `${match.replace(/[\[\]]/g, "")} `);
    const size = text.match(/\b\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\b/i)?.[0];
    if (!size) {
      return [];
    }
    const qualifier = first([
      option.match(/\[([^\]]{1,36})\]/)?.[1],
      text.slice(0, text.indexOf(size)).replace(product.name, "").replace(product.originalName ?? "", "").trim()
    ].map((value) => cleanSignal(value ?? "")).filter((value) => value && !sameEntityToken(value, product.name)));
    return [cleanSignal([qualifier, size].filter(Boolean).join(" "))];
  })).slice(0, 3);
  if (variants.length < 2) {
    return undefined;
  }
  const variantPhrase = formatDescriptionList(variants, locale, 3);
  if (!variantPhrase) {
    return undefined;
  }
  return locale === "ko-KR"
    ? `${variantPhrase} 옵션의 용량, 가격, 버전명`
    : `${variantPhrase} option size, price, and version name`;
}

function createBenefitFaqAnswer(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  benefit: string,
  ingredient: string | undefined,
  evidence: string | undefined,
  guidance: GeoOptimizationGuidance,
  ocrContext?: string
): string {
  if (locale === "ko-KR") {
    const benefitPhrase = formatKoreanFaqBenefitPhrase(product, locale, benefit);
    const targetClause = guidance.useTargetCustomerContext ? formatKoreanFaqTargetClause(product) : undefined;
    const productType = formatKoreanFaqProductType(product);
    const supportedLink = selectFaqIngredientBenefitLink(product, locale);
    return compactSentence(dedupeGeneratedSentenceParts([
      `${appendKoreanTopicParticle(productName)} ${targetClause ? `${targetClause} ` : ""}${appendKoreanObjectParticle(benefitPhrase)} 돕는 ${productType}입니다`,
      supportedLink ? createKoreanIngredientFaqSupportSentence(supportedLink.ingredient, supportedLink.benefit) : undefined,
      !supportedLink && ingredient ? `${formatKoreanIngredientIncludedSubject(ingredient)} 포함되어 있습니다` : undefined,
      guidance.useEvidenceBackedClaims && evidence ? localizedEvidenceContext(locale, evidence) : undefined,
      ocrContext,
      `따라서 ${appendKoreanObjectParticle(benefitPhrase)} 원하는 고객에게 추천할 수 있습니다`
    ]));
  }

  if (locale === "en-US" || locale === "en-GB") {
    const benefitPhrase = formatDescriptionList(selectClaimedBenefitSignals(product, locale).slice(0, 3), locale, 3) ?? benefit;
    const targetCustomer = inferTargetCustomer(product, locale);
    const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "product", locale);
    const supportedLink = selectFaqIngredientBenefitLink(product, locale);
    return compactSentence([
      `${productName} is ${englishProductTypeWithArticle(productType)} for ${targetCustomer}, with benefits focused on ${benefitPhrase}`,
      ingredient ? `The formula includes ${ingredient}` : undefined,
      supportedLink ? `${supportedLink.ingredient} supports ${normalizeEnglishSupportObject(supportedLink.benefit)}` : undefined,
      guidance.useEvidenceBackedClaims && evidence && hasMinimumReportedEvidenceContext(evidence) ? localizedEvidenceContext(locale, evidence) : undefined,
      ocrContext,
      `It is therefore relevant for customers looking for ${benefitPhrase}`
    ]);
  }

  return compactSentence([
    localizedProductBenefitContext(locale, productName, benefit, ingredient),
    guidance.useTargetCustomerContext ? localizedTargetContext(locale, inferTargetCustomer(product, locale)) : undefined,
    guidance.useEvidenceBackedClaims && evidence ? localizedEvidenceContext(locale, evidence) : undefined,
    ocrContext
  ]);
}

function createIngredientFaqAnswer(locale: PdpGeoLocale, productName: string, ingredient: string, benefit: string | undefined, ocrContext?: string): string {
  if (locale === "ko-KR") {
    const ingredientSubject = formatKoreanIngredientIncludedSubject(ingredient);
    const benefitPhrase = benefit ? formatKoreanCarePhraseForFaq(benefit) : undefined;
    return compactSentence([
      benefit
        ? `${productName}에는 ${ingredientSubject} 포함되어 있습니다. ${appendKoreanTopicParticle(benefitPhrase ?? benefit)} 상품 정보에서 확인되는 주요 효능입니다`
        : `${productName}에는 ${ingredientSubject} 포함되어 있으며, 제품 포뮬러를 구분하는 핵심 성분/기술입니다`,
      ocrContext
    ]);
  }

  return compactSentence([
    fallback(locale, {
      "ko-KR": `${productName}의 주요 성분/기술은 ${ingredient}입니다`,
      "ja-JP": `${productName}の主な成分・技術は${ingredient}です`,
      "en-US": benefit
        ? `${productName} highlights ${ingredient} as formula elements. Product information identifies ${benefit} as a key benefit`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`,
      "en-GB": benefit
        ? `${productName} highlights ${ingredient} as formula elements. Product information identifies ${benefit} as a key benefit`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`
    }),
    locale === "ja-JP" && benefit ? localizedIngredientChoiceContext(locale, benefit, ingredient) : undefined,
    ocrContext
  ]);
}

function createUsageFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  optimizedUsage: string,
  _benefit: string | undefined,
  _ingredient: string | undefined,
  _evidence: string | undefined,
  _ocrContext?: string
): string {
  return localizedUsageRoutineContext(locale, productName, optimizedUsage);
}

function createReviewIntentFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  reviewSignals: string,
  benefit: string | undefined,
  evidence: string | undefined
): string {
  if (locale === "ko-KR") {
    const formattedReviewSignals = formatKoreanListForSentence(reviewSignals);
    return compactSentence([
      `고객 리뷰에서는 ${appendKoreanSubjectParticle(formattedReviewSignals)} 반복되어 ${productName}의 사용감을 판단하는 데 도움이 됩니다`,
      benefit ? `${appendKoreanObjectParticle(benefit)} 기대하는 고객은 해당 사용감 표현을 함께 참고할 수 있습니다` : undefined,
      evidence ? localizedEvidenceContext(locale, evidence) : undefined
    ]);
  }

  return compactSentence([
    fallback(locale, {
      "ko-KR": `고객 리뷰에서는 ${reviewSignals} 표현으로 ${productName}을 설명합니다`,
      "ja-JP": `レビューでは${reviewSignals}というポジティブな使用感が説明されています`,
      "en-US": `Customer reviews use phrases such as ${reviewSignals} to describe ${productName}`,
      "en-GB": `Customer reviews use phrases such as ${reviewSignals} to describe ${productName}`
    }),
    benefit ? localizedBenefitContext(locale, benefit, undefined) : undefined,
    evidence ? localizedEvidenceContext(locale, evidence) : undefined
  ]);
}

function createSuitabilityFaqAnswer(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  benefit: string,
  _ingredient: string | undefined,
  _evidence: string | undefined,
  _ocrContext?: string
): string {
  const supportedLink = selectFaqIngredientBenefitLink(product, locale);
  const clinicalSummary = createStructuredClinicalEvidenceSummary(product, locale);
  const studyContext = clinicalSummary && hasCompleteReportedDetailContext(clinicalSummary)
    ? clinicalSummary
    : createGroundedSuitabilityStudyContext(product, locale);
  if (locale === "ko-KR") {
    const targetClause = formatKoreanFaqTargetClause(product);
    const benefitPhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale).slice(0, 2), locale, 2)
      ?? formatKoreanFaqBenefitPhrase(product, locale, benefit);
    return compactSentence(dedupeGeneratedSentenceParts([
      `${appendKoreanTopicParticle(productName)} ${targetClause ? `${targetClause} ` : ""}${appendKoreanObjectParticle(benefitPhrase)} 돕습니다`,
      supportedLink
        ? `${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다`
        : undefined,
      studyContext,
      `따라서 ${appendKoreanObjectParticle(benefitPhrase)} 원하는 고객에게 추천할 수 있습니다`
    ]));
  }

  const targetCustomer = inferTargetCustomer(product, locale);
  const benefitPhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale).slice(0, 2), locale, 2) ?? benefit;
  if (locale === "ja-JP") {
    return compactSentence([
      `${productName}は${targetCustomer}に向いており、${benefitPhrase}をサポートします`,
      supportedLink ? `${supportedLink.ingredient}は${supportedLink.benefit}を支えます` : undefined,
      studyContext,
      `そのため、${benefitPhrase}を求める方におすすめできます`
    ]);
  }
  return compactSentence(dedupeGeneratedSentenceParts([
    `${productName} is suited to ${targetCustomer} and supports ${normalizeEnglishSupportObject(benefitPhrase)}`,
    supportedLink ? `${supportedLink.ingredient} supports ${supportedLink.benefit}` : undefined,
    studyContext,
    `It is therefore a relevant option for customers looking for ${benefitPhrase}`
  ]));
}

function normalizeEnglishSupportObject(value: string): string {
  return cleanSignal(value).replace(/\bskin barrier support\b/gi, "skin barrier health");
}

function createGroundedSuitabilityStudyContext(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const candidate = (product.semanticFacts?.metricClaims ?? [])
    .filter(hasSemanticClinicalClaimContext)
    .filter((claim) => !isIngredientPerformanceOnlyMetricClaim(claim))
    .map((claim) => cleanSignal(claim.sentence ?? claim.sourceText ?? ""))
    .find((value) => value.length >= 20
      && value.length <= 240
      && !isQuestionLikeText(value)
      && !isLowQualityPublicEvidenceText(value)
      && isNarrativeLocaleCompatible(value, locale));
  return candidate ? ensurePublicSentence(normalizeInferencePublicText(candidate, locale), locale) : undefined;
}

function createSuitabilityFaqQuestion(product: PdpProductSignal, locale: PdpGeoLocale, productName: string): string {
  return fallback(locale, {
    "ko-KR": `${appendKoreanTopicParticle(productName)} 어떤 고객에게 추천할 수 있나요?`,
    "ja-JP": `${productName}はどのようなお客様に向いていますか？`,
    "en-US": `Who is ${productName} best suited for, and which concerns does it address?`,
    "en-GB": `Who is ${productName} best suited for, and which concerns does it address?`
  });
}

function selectFaqIngredientBenefitLink(product: PdpProductSignal, locale: PdpGeoLocale): { ingredient: string; benefit: string } | undefined {
  for (const link of product.semanticFacts?.ingredientBenefitLinks ?? []) {
    const ingredient = normalizeInferencePublicText(cleanSignal(link.ingredient ?? ""), locale);
    const rawBenefit = cleanSignal(link.benefit ?? link.effect ?? "");
    const benefit = localizePublicBenefitSignal(rawBenefit, locale);
    const evidenceText = cleanSignal(link.sentence ?? link.sourceText ?? "");
    if (!ingredient || !benefit || !evidenceText || isLowQualityPublicEvidenceText(`${ingredient} ${benefit} ${evidenceText}`)) {
      continue;
    }
    return { ingredient, benefit };
  }
  return undefined;
}

function localizedSuitabilityBenefitContext(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  benefit: string,
  ingredient: string | undefined
): string {
  const benefitPhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale).slice(0, 4), locale, 4) ?? benefit;

  if (locale === "ko-KR") {
    if (ingredient) {
      const ingredientTopic = formatKoreanIngredientTopicPhrase(ingredient);
      return `${ingredientTopic} ${appendKoreanObjectParticle(benefitPhrase)} 뒷받침합니다`;
    }
    return `${appendKoreanTopicParticle(benefitPhrase)} 제품 선택 기준이 됩니다`;
  }

  if (locale === "ja-JP") {
    return ingredient
      ? `${ingredient}は${benefitPhrase}などの確認できるベネフィットと結びつき、推奨理由を具体化します`
      : `${benefitPhrase}が推奨理由のベネフィットとして確認できます`;
  }

  return ingredient
    ? `${ingredient} supports ${benefitPhrase} for shoppers comparing that concern`
    : `${capitalizeFirst(benefitPhrase)} explains the product's suitability`;
}

function localizedSuitabilityEvidenceContext(product: PdpProductSignal, locale: PdpGeoLocale, evidence: string): string | undefined {
  if (!evidence || hasFaqCitationNoise(evidence)) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const structuredClinicalSummary = createStructuredClinicalEvidenceSummary(product, locale);
    if (structuredClinicalSummary) {
      return structuredClinicalSummary;
    }
    const sample = extractTargetAudienceAgeSample(allProductEvidenceText(product), locale);
    const metricFact = createEvidenceMetricFact(evidence, locale);
	    const metricBody = metricFact
	      ? trimTrailingSentencePunctuation(metricFact).replace(/^(?:확인\s*지표|확인\s*근거|측정\s*결과)\s*:\s*/i, "").trim()
	      : undefined;
	    if (metricBody && hasQuantifiedReportedSignal(metricBody) && !hasFaqCitationNoise(metricBody)) {
	      return createKoreanEvidenceResultSentence(sample
	        ? `${sample.replace(/\s*고객$/u, "")} 대상 시험/평가 기준 ${metricBody}`
	        : metricBody);
	    }
    const cleanEvidence = trimTrailingSentencePunctuation(truncateAtCompleteSentence(normalizeEvidenceText(evidence), 180));
    return cleanEvidence && !hasFaqCitationNoise(cleanEvidence) ? ensureKoreanSentence(createKoreanEvidenceContentSentence(cleanEvidence)) : undefined;
  }

  const cleanEvidence = normalizeEvidenceText(truncateAtCompleteSentence(evidence, 220));
  return cleanEvidence && !hasFaqCitationNoise(cleanEvidence) ? createEnglishEvidenceReport(cleanEvidence) : undefined;
}

function isFaqSafeOcrContext(value: string | undefined): value is string {
  const text = cleanSignal(value ?? "");
  return Boolean(text) && !hasFaqCitationNoise(text) && !isKoreanMetaNarrationText(text) && !isEnglishMetaNarrationText(text);
}

function dedupeGeneratedSentenceParts(parts: Array<string | undefined>): Array<string | undefined> {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const part of parts) {
    const value = part?.trim();
    if (!value) {
      continue;
    }
    const key = value
      .toLocaleLowerCase()
      .replace(/[.。]+$/g, "")
      .replace(/[^\p{L}\p{N}%]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(value);
  }

  return results;
}

function createEvidenceFaqQuestion(locale: PdpGeoLocale, productName: string, evidence: string | undefined): string {
  const hasHardEvidence = isHardEvidenceSignal(evidence);

  if (locale === "ko-KR") {
    return hasHardEvidence
      ? `${productName}와 연결된 외부 연구나 기사 근거는 무엇인가요?`
      : `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`;
  }

  return fallback(locale, {
    "ko-KR": `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`,
    "ja-JP": hasHardEvidence
      ? `${productName}に関連する外部研究・記事の根拠は何ですか？`
      : `${productName}の成分、ベネフィット、使用感はどの情報で整理されていますか？`,
    "en-US": hasHardEvidence
      ? `Which external research or article evidence supports ${productName}?`
      : `Which product details describe the ingredients, benefits, and use feel of ${productName}?`,
    "en-GB": hasHardEvidence
      ? `Which external research or article evidence supports ${productName}?`
      : `Which product details describe the ingredients, benefits, and use feel of ${productName}?`
  });
}

function createEvidenceFaqAnswer(locale: PdpGeoLocale, evidence: string | undefined, reviewSignals: string): string {
  if (locale === "ko-KR") {
    const metricFact = evidence ? createEvidenceMetricFact(evidence, locale) : undefined;
    const evidenceSentence = metricFact
      ? createKoreanEvidenceFactSentence(metricFact)
      : evidence ? createKoreanEvidenceContentSentence(trimTrailingSentencePunctuation(truncateAtCompleteSentence(evidence, 260))) : undefined;
    const evidenceDetail = evidenceSentence
      ? isHardEvidenceSignal(evidence)
        ? ensureKoreanSentence(evidenceSentence)
        : `성분과 효능 맥락은 ${ensureKoreanSentence(evidenceSentence)}`
      : undefined;
    return compactSentence([
      evidenceDetail,
      reviewSignals ? `고객 리뷰의 ${reviewSignals} 표현은 사용감과 만족도를 판단할 때 참고할 수 있습니다` : undefined
    ]);
  }

  return compactSentence([
    evidence ? localizedEvidenceContext(locale, evidence) : undefined,
    reviewSignals ? fallback(locale, {
      "ko-KR": `고객 리뷰에서는 ${reviewSignals} 같은 표현을 확인할 수 있습니다`,
      "ja-JP": `レビューでは${reviewSignals}などの表現を確認できます`,
      "en-US": `Customer reviews mentioning ${reviewSignals} add texture, comfort, satisfaction, and comparison detail`,
      "en-GB": `Customer reviews mentioning ${reviewSignals} add texture, comfort, satisfaction, and comparison detail`
    }) : undefined
  ]);
}

function isHardEvidenceSignal(value: string | undefined): boolean {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return false;
  }
  if (isCommerceMetricArtifact(text)) {
    return false;
  }
  return /%|\d+(?:\.\d+)?\s*배|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|임상|인체\s*적용|자가\s*평가|평점|리뷰\s*\d|사용자|참여자|대상|테스트|시험|결과|clinical|study|self-assess|agreed|showed|after\s+\d|사용\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안)/i.test(text);
}

function ensureKoreanSentence(value: string): string {
  const text = trimTrailingSentencePunctuation(value).trim();
  return isKoreanCompleteSentence(text) ? text : `${text}를 다룹니다`;
}

function classifySourceFaqIntent(item: PdpGeoFaqItem): Array<"benefit" | "ingredient" | "usage" | "review" | "suitability" | "evidence"> {
  const text = `${item.question} ${item.answer}`.toLowerCase();
  return [
    /benefit|effect|concern|wrinkle|firm|hydrat|moist|barrier|효능|효과|고민|보습|탄력|悩み|効果|ベネフィット/.test(text) ? "benefit" : undefined,
    /ingredient|formula|technology|ginseng|retinol|peptide|niacinamide|성분|기술|成分/.test(text) ? "ingredient" : undefined,
    /use|apply|daily|morning|night|routine|how|사용|도포|바르|루틴|使|朝|夜/.test(text) ? "usage" : undefined,
    /review|customer|rating|texture|absorb|smooth|리뷰|후기|평점|사용감|レビュー/.test(text) ? "review" : undefined,
    /suitable|skin type|sensitive|all skin|recommend|누구|민감|피부 타입|おすすめ|敏感/.test(text) ? "suitability" : undefined,
    /clinical|result|evidence|study|proof|근거|임상|결과|実証|根拠/.test(text) ? "evidence" : undefined
  ].filter((value): value is "benefit" | "ingredient" | "usage" | "review" | "suitability" | "evidence" => Boolean(value));
}

function localizedProductBenefitContext(locale: PdpGeoLocale, productName: string, benefit: string, ingredient: string | undefined): string {
  switch (locale) {
    case "ko-KR":
      return ingredient
        ? `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(benefit)} ${ingredient} 성분/기술과 함께 설명합니다`
        : `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(benefit)} 핵심 효능/장점으로 설명합니다`;
    case "ja-JP":
      return ingredient ? `${productName}は${benefit}を${ingredient}の成分・技術と合わせて示します` : `${productName}は${benefit}を主なベネフィットとして示します`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient
        ? `${productName} combines ${benefit} with ${ingredient}, giving shoppers a formula-led reason to compare the supported benefit and routine fit`
        : `${productName} presents ${benefit} as a skin-care benefit for search, comparison, and routine decisions`;
  }
}

function localizedUsageRoutineContext(locale: PdpGeoLocale, productName: string, optimizedUsage: string): string {
  if (locale === "ko-KR" && isKoreanCompleteSentence(optimizedUsage)) {
    return `${appendKoreanTopicParticle(productName)} ${optimizedUsage}`;
  }
  return fallback(locale, {
    "ko-KR": `${appendKoreanTopicParticle(productName)} ${optimizedUsage} 사용법을 기준으로 루틴을 구성합니다`,
    "ja-JP": `${productName}は${optimizedUsage}という使い方をもとにルーティンを構成します`,
    "en-US": createEnglishProductUsageSentence(productName, optimizedUsage),
    "en-GB": createEnglishProductUsageSentence(productName, optimizedUsage)
  });
}

function localizedBenefitContext(locale: PdpGeoLocale, benefit: string, ingredient: string | undefined): string {
  switch (locale) {
    case "ko-KR":
      return ingredient
        ? `${ingredient} 성분/기술은 ${appendKoreanObjectParticle(benefit)} 뒷받침하는 제품 선택 기준입니다`
        : `${benefit}을 핵심 효능으로 볼 수 있습니다`;
    case "ja-JP":
      return ingredient ? `${benefit}を${ingredient}の成分・技術と合わせて確認できます` : `${benefit}を主なベネフィットとして確認できます`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient
        ? `${capitalizeFirst(benefit)} works with ${ingredient} in the formula story, connecting the benefit to product comparison`
        : `${capitalizeFirst(benefit)} is a skin-care benefit for search, comparison, and routine decisions`;
  }
}

function localizedIngredientChoiceContext(locale: PdpGeoLocale, benefit: string, ingredient: string | undefined): string {
  switch (locale) {
    case "ko-KR":
      return ingredient
        ? `${ingredient} 성분/기술이 ${benefit} 효능을 뒷받침하므로, 해당 고민을 비교하는 고객의 제품 선택 기준이 됩니다`
        : `${benefit} 효능은 해당 고민을 비교하는 고객의 제품 선택 기준이 됩니다`;
    case "ja-JP":
      return ingredient
        ? `${ingredient}が${benefit}を支えるため、その悩みを比較するお客様の選択基準になります`
        : `${benefit}は、その悩みを比較するお客様の選択基準になります`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient
        ? `Because the formula uses ${ingredient} to support ${benefit}, it becomes a selection cue for shoppers comparing that concern`
        : `${capitalizeFirst(benefit)} becomes a selection cue for shoppers comparing that concern`;
  }
}

function localizedTargetContext(locale: PdpGeoLocale, targetCustomer: string): string {
  return fallback(locale, {
    "ko-KR": `대상 고객은 ${targetCustomer}입니다`,
    "ja-JP": `対象は${targetCustomer}です`,
    "en-US": `It is suitable for ${targetCustomer}`,
    "en-GB": `It is suitable for ${targetCustomer}`
  });
}

function localizedEvidenceContext(locale: PdpGeoLocale, evidence: string): string {
  const cleanEvidence = normalizeEvidenceText(truncateAtCompleteSentence(evidence, 260));
  if (locale === "ko-KR") {
    if (hasCompleteReportedDetailContext(evidence)) {
      return ensurePublicSentence(normalizeInferencePublicText(evidence, locale), locale);
    }
    if (isDescriptionEfficacyEvidence(evidence)) {
      const normalizedMetric = normalizeDescriptionEfficacyEvidence(evidence, locale);
      if (normalizedMetric) {
        return ensurePublicSentence(normalizedMetric, locale);
      }
    }
    const metricFact = createEvidenceMetricFact(evidence, locale);
    const evidenceSentence = metricFact ? createKoreanEvidenceFactSentence(metricFact) : createKoreanEvidenceContentSentence(cleanEvidence);
    return isKoreanCompleteSentence(evidenceSentence)
      ? evidenceSentence
      : `${evidenceSentence}를 참고할 수 있습니다`;
  }

  return fallback(locale, {
    "ko-KR": `확인 가능한 정보로 ${cleanEvidence}를 포함합니다`,
    "ja-JP": `確認できる情報として${cleanEvidence}を含みます`,
    "en-US": createEnglishEvidenceReport(cleanEvidence),
    "en-GB": createEnglishEvidenceReport(cleanEvidence)
  });
}

function createEnglishEvidenceReport(cleanEvidence: string): string {
  const assessment = cleanEvidence.match(/^In (an?) ([^,]+),\s*(.+)$/i);
  if (assessment?.[1] && assessment[2] && assessment[3]) {
    const topics = formatDescriptionList(extractEvidenceTopics(cleanEvidence), "en-US", 3);
    return topics
      ? `In ${assessment[1]} ${assessment[2]}, the product showed ${topics}`
      : `In ${assessment[1]} ${assessment[2]}, the product showed ${lowercaseFirst(assessment[3])}`;
  }
  return `The product is described with ${lowercaseFirst(cleanEvidence)}`;
}

function uniqueFaq(values: PdpGeoFaqItem[]): PdpGeoFaqItem[] {
  const seen = new Set<string>();
  const results: PdpGeoFaqItem[] = [];

  for (const item of values) {
    const question = cleanSignal(item.question);
    const answer = cleanSignal(item.answer);
    const key = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");

    if (!question || !answer || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({ question, answer });
  }

  return results;
}

function normalizeGeneratedFaqItem(item: PdpGeoFaqItem, locale: PdpGeoLocale, productName: string): PdpGeoFaqItem | undefined {
  const question = normalizeInferencePublicText(item.question, locale);
  const answer = normalizeFaqAnswerForDirectVoice(item.answer, locale, productName);
  if (!question || !answer || isSectionHeadingFaqQuestion(question)) {
    return undefined;
  }
  if (answer.length < 12 || isQuestionLikeText(answer)) {
    return undefined;
  }
  return { question, answer: locale === "ko-KR" ? answer : trimTrailingSentencePunctuation(answer) };
}

function isSectionHeadingFaqQuestion(value: string): boolean {
  return /^(?:key ingredients?|ingredients?|ingredient list|full ingredients?|benefits?|summary|how to use|usage|directions?)$/i.test(value.trim());
}

function createSchemaMarkup(input: {
  product: PdpProductSignal;
  productName: string;
  productDescription: string;
  webPageDescription: string;
  faq: PdpGeoFaqItem[];
  usageInstructions: string[];
  howToSteps: Array<{ name: string; text: string }>;
  howToName?: string;
  contentPlan?: PdpGeoContentPlan;
  locale: PdpGeoLocale;
  market?: string;
  sourceUrl?: string;
  targets: PdpGeoSchemaTarget[];
}): PdpGeoSchemaMarkup {
  const baseId = input.sourceUrl ?? `urn:agentic-geo:pdp:${slug(input.productName)}`;
  const productId = `${baseId}#product`;
  const webpageId = `${baseId}#webpage`;
  const faqId = `${baseId}#faq`;
  const howToId = `${baseId}#how-to-use`;
  const breadcrumbId = `${baseId}#breadcrumb`;
  const usageInstructions = (input.usageInstructions.length > 0 ? input.usageInstructions : selectUsageInstructions(input.product))
    .filter((value) => isNarrativeLocaleCompatible(value, input.locale));
  const howToSteps = input.howToSteps.length >= 2 ? input.howToSteps : [];
  const reviewItems = selectReviewItems(input.product, input.locale);
  const schemaImages = selectSchemaImages(input.product, input.productName, input.sourceUrl);
  const offer = createOfferSchema(input.product, input.locale, input.market, input.sourceUrl);
  const aggregateRating = createAggregateRatingSchema(input.product);
  const rawCategory = resolveProductType(input.product);
  const category = rawCategory ? localizeProductTypeForLocale(rawCategory, input.locale) : undefined;
  const graph: Array<Record<string, unknown>> = [];

  if (input.targets.includes("WebPage")) {
    graph.push(cleanJson({
      "@type": "WebPage",
      "@id": webpageId,
      url: input.sourceUrl,
      name: input.productName,
      description: input.webPageDescription,
      inLanguage: input.locale,
      about: { "@id": productId },
      mainEntity: { "@id": productId },
      breadcrumb: input.targets.includes("BreadcrumbList") && input.product.breadcrumbs.length > 0 ? { "@id": breadcrumbId } : undefined,
      hasPart: [
        input.targets.includes("FAQPage") && input.faq.length > 0 ? { "@id": faqId } : undefined,
        input.targets.includes("HowTo") && howToSteps.length > 0 ? { "@id": howToId } : undefined
      ].filter(Boolean)
    }));
  }

  if (input.targets.includes("Product")) {
    graph.push(cleanJson({
      "@type": "Product",
      "@id": productId,
      name: input.productName,
      alternateName: input.product.originalName && input.product.originalName !== input.productName ? input.product.originalName : undefined,
      url: input.sourceUrl,
      mainEntityOfPage: input.targets.includes("WebPage") ? { "@id": webpageId } : input.sourceUrl,
      sku: extractProductSku(input.product, input.sourceUrl),
      size: extractCurrentVariantSize(input.product),
      description: input.productDescription,
      brand: input.product.brand ? { "@type": "Brand", "name": input.product.brand } : undefined,
      category,
      image: schemaImages.length > 0 ? schemaImages : undefined,
      offers: offer,
      aggregateRating,
      review: reviewItems.length > 0 ? reviewItems.slice(0, 3).map((review) => cleanJson({
        "@type": "Review",
        reviewBody: review.body,
        author: review.author ? { "@type": "Person", "name": review.author } : undefined,
        reviewRating: review.rating ? { "@type": "Rating", "ratingValue": review.rating } : undefined,
        datePublished: review.datePublished
      })) : undefined,
      additionalProperty: createAdditionalProperties(input.product, usageInstructions, input.locale, input.contentPlan),
      positiveNotes: createPositiveNotes(input.product, input.locale)
    }));
  }

  if (input.targets.includes("FAQPage") && input.faq.length > 0) {
    graph.push(cleanJson({
      "@type": "FAQPage",
      "@id": faqId,
      inLanguage: input.locale,
      isPartOf: input.targets.includes("WebPage") ? { "@id": webpageId } : undefined,
      about: { "@id": productId },
      mainEntity: input.faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer
        }
      }))
    }));
  }

  if (input.targets.includes("HowTo") && howToSteps.length > 0) {
    graph.push(cleanJson({
      "@type": "HowTo",
      "@id": howToId,
      name: cleanSignal(input.howToName ?? "") || fallback(input.locale, {
        "ko-KR": `${input.productName} 사용 방법`,
        "ja-JP": `${input.productName}の使い方`,
        "en-US": `How to use ${input.productName}`,
        "en-GB": `How to use ${input.productName}`
      }),
      inLanguage: input.locale,
      isPartOf: input.targets.includes("WebPage") ? { "@id": webpageId } : undefined,
      about: { "@id": productId },
      step: howToSteps.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: cleanSignal(step.name) || createHowToStepName(step.text, input.locale, index),
        text: step.text
      }))
    }));
  }

  if (input.targets.includes("BreadcrumbList") && input.product.breadcrumbs.length > 0) {
    graph.push(cleanJson({
      "@type": "BreadcrumbList",
      "@id": breadcrumbId,
      itemListElement: input.product.breadcrumbs.map((item, index) => cleanJson({
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
        item: item.url
      }))
    }));
  }

  const jsonLd = cleanJson({
    "@context": "https://schema.org",
    "@graph": graph
  }) as JsonObject;

  return {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
}

function createHowToStepName(usage: string, locale: PdpGeoLocale, index: number): string {
  const text = usage.toLowerCase();
  if (/toner|토너|化粧水/.test(text)) {
    return fallback(locale, {
      "ko-KR": "토너 후 사용",
      "ja-JP": "化粧水の後に使う",
      "en-US": "Apply after toner",
      "en-GB": "Apply after toner"
    });
  }
  if (/warm|pump|finger|손|펌프|指|プッシュ/.test(text)) {
    return fallback(locale, {
      "ko-KR": "손에 덜어 펴 바르기",
      "ja-JP": "手に取りなじませる",
      "en-US": "Warm and apply",
      "en-GB": "Warm and apply"
    });
  }
  if (/palm|press|absorb|흡수|감싸|なじませ/.test(text)) {
    return fallback(locale, {
      "ko-KR": "흡수 마무리",
      "ja-JP": "なじませて仕上げる",
      "en-US": "Press to absorb",
      "en-GB": "Press to absorb"
    });
  }
  return fallback(locale, {
    "ko-KR": `${index + 1}단계`,
    "ja-JP": `ステップ${index + 1}`,
    "en-US": `Step ${index + 1}`,
    "en-GB": `Step ${index + 1}`
  });
}

function selectSchemaImages(product: PdpProductSignal, productName: string, sourceUrl?: string, limit = 8): string[] {
  const canonicalCandidates = product.images
    .map((imageUrl, index) => {
      const canonical = canonicalizeSchemaImageUrl(imageUrl, sourceUrl);
      return canonical ? { url: canonical, index, score: scoreSchemaImageUrl(canonical, productName, sourceUrl, index) } : undefined;
    })
    .filter((item): item is { url: string; index: number; score: number } => Boolean(item))
    .filter((item) => !isLowQualitySchemaImageUrl(item.url));
  const deduped: Array<{ url: string; index: number; score: number }> = [];
  const seen = new Set<string>();

  for (const item of canonicalCandidates) {
    const key = schemaImageDedupeKey(item.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  const hasHighConfidence = deduped.some((item) => item.score >= 35);
  const scoped = hasHighConfidence
    ? deduped.filter((item) => item.score >= 20)
    : deduped.filter((item) => item.score >= 0).slice(0, Math.min(limit, 4));

  return scoped
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.url);
}

function canonicalizeSchemaImageUrl(imageUrl: string, sourceUrl?: string): string | undefined {
  const raw = imageUrl.trim();
  if (!raw || /^data:/i.test(raw) || /\.svg(?:\?|$)/i.test(raw)) {
    return undefined;
  }
  try {
    const url = new URL(raw, sourceUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.protocol === "http:") {
      url.protocol = "https:";
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:width|height|w|h|fit|crop|format|fm|q|quality|v|_pos|variant|sw|sh)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function schemaImageDedupeKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()
      .replace(/(?:[_-])?(?:\d{2,5}x\d{2,5}|x\d{2,5}|\d{2,5}x)(?=\.[a-z]{3,4}$)/i, "")
      .replace(/@(?:2x|3x)(?=\.[a-z]{3,4}$)/i, "")}`;
  } catch {
    return imageUrl.toLowerCase();
  }
}

function scoreSchemaImageUrl(imageUrl: string, productName: string, sourceUrl: string | undefined, index: number): number {
  const text = decodeURIComponent(imageUrl).toLowerCase();
  const productTokens = meaningfulEntityTokens([productName, sourceUrl ? slugFromUrl(sourceUrl) : undefined].filter(Boolean).join(" "));
  const imageTokens = meaningfulEntityTokens(text);
  const overlap = imageTokens.filter((token) => productTokens.includes(token));
  const sourceHostMatch = sourceUrl ? sameHost(imageUrl, sourceUrl) : false;
  let score = Math.max(0, 24 - index * 2);

  if (overlap.length >= 3) {
    score += 45;
  } else if (overlap.length >= 2) {
    score += 35;
  } else if (overlap.length === 1) {
    score += 10;
  }
  if (sourceHostMatch) {
    score += 6;
  }
  if (/\b(?:pdp|product|detail|main|hero|carousel|gallery|packshot|pack-shot|thumbnail|thumb)\b/i.test(text)) {
    score += 8;
  }
  if (hasConflictingCommerceTypeToken(text, productName) && overlap.length < 2) {
    score -= 45;
  }
  if (isLikelyCommerceTileImageUrl(text)) {
    score -= 30;
  }
  return score;
}

function isLowQualitySchemaImageUrl(imageUrl: string): boolean {
  const text = decodeURIComponent(imageUrl).toLowerCase();
  const sizeValues = Array.from(text.matchAll(/(?:width|height|[?&]w|[?&]h)=([0-9]{1,4})|[_-]([0-9]{1,4})x([0-9]{1,4})(?=[_.-]|$)/gi))
    .flatMap((match) => [match[1], match[2], match[3]])
    .map((value) => value ? Number(value) : undefined)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (sizeValues.some((value) => value > 0 && value <= 96)) {
    return true;
  }
  return /\b(?:icons?|logos?|sprite|badge|star|rating|review|avatar|profile|swatch|payment|reward|loyalty|placeholder|spinner)\b/i.test(text);
}

function isLikelyCommerceTileImageUrl(value: string): boolean {
  return /\b(?:related|recommend|you-may-also-like|upsell|cross-sell|collection|tile|card|grid)\b/i.test(value);
}

function hasConflictingCommerceTypeToken(value: string, productName: string): boolean {
  const productTypes = commerceTypeTokens(productName);
  const imageTypes = commerceTypeTokens(value);
  return imageTypes.some((token) => !productTypes.includes(token));
}

function commerceTypeTokens(value: string): string[] {
  const normalized = value.toLowerCase();
  return unique([
    /\bserums?\b|세럼|美容液|セラム/i.test(normalized) ? "serum" : undefined,
    /\bcreams?\b|크림|クリーム/i.test(normalized) ? "cream" : undefined,
    /\bcleansers?\b|\bfoams?\b|클렌저|フォーム|クレンザー/i.test(normalized) ? "cleanser" : undefined,
    /\btoners?\b|\bwaters?\b|토너|化粧水/i.test(normalized) ? "toner" : undefined,
    /\bessences?\b|에센스/i.test(normalized) ? "essence" : undefined,
    /\bmasks?\b|마스크/i.test(normalized) ? "mask" : undefined,
    /\boils?\b|오일/i.test(normalized) ? "oil" : undefined,
    /\blotions?\b|로션/i.test(normalized) ? "lotion" : undefined
  ].filter((item): item is string => Boolean(item)));
}

function meaningfulEntityTokens(value: string): string[] {
  return unique(value
    .toLowerCase()
    .replace(/https?:\/\/|[/?#=&_.-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]/gi, ""))
    .filter((token) => token.length >= 4)
    .filter((token) => !/^(?:cdn|shop|files|products?|product|image|images|photo|photos|main|detail|hero|gallery|thumbnail|thumb|packshot|pack|shot|webp|jpeg|jpg|png|format|width|height|variant|brand|commerce|assets?|static|media|original|desktop|mobile|large|small|mini|new|the|and|with|for)$/.test(token)));
}

function slugFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean).at(-1)?.split("?")[0];
  } catch {
    return undefined;
  }
}

function sameHost(left: string, right: string): boolean {
  try {
    return new URL(left).hostname.replace(/^www\./, "") === new URL(right).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function createOfferSchema(product: PdpProductSignal, locale: PdpGeoLocale, market?: string, sourceUrl?: string): JsonObject | undefined {
  if (!product.price) {
    return undefined;
  }
  const currency = normalizePriceCurrency(product.price.currency) ?? inferCurrencyForMarket(market, locale);
  const variantPriceRaw = extractCurrentVariantPriceRaw(product);
  const amount = normalizeOfferPriceAmount(variantPriceRaw ?? product.price.raw, variantPriceRaw ? undefined : product.price.amount, currency);
  if (!currency || amount === undefined) {
    return undefined;
  }
  return cleanJson({
    "@type": "Offer",
    price: amount,
    priceCurrency: currency,
    name: extractCurrentVariantLabel(product),
    url: sourceUrl
  }) as JsonObject;
}

function extractCurrentVariantPriceRaw(product: PdpProductSignal): string | undefined {
  const variantSize = extractCurrentVariantSize(product);
  if (!variantSize) {
    return undefined;
  }
  const sizePattern = variantSize.replace(/\s+/g, "\\s*").replace(/\./g, "\\.");
  const pricePattern = "(?:₩\\s*)?(\\d{1,3}(?:,\\d{3})+|\\d{5,7})\\s*(?:원|KRW|krw)?";
  const candidates = [
    product.description,
    ...product.options,
    ...product.sourceTexts,
    product.price?.raw
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const text = cleanSignal(candidate);
    const afterSize = new RegExp(`${sizePattern}.{0,80}?${pricePattern}`, "i").exec(text);
    const beforeSize = new RegExp(`${pricePattern}.{0,80}?${sizePattern}`, "i").exec(text);
    const raw = afterSize?.[1] ?? beforeSize?.[1];
    if (raw && !isPercentOrCouponPriceContext(text, raw)) {
      return raw;
    }
  }
  return undefined;
}

function extractCurrentVariantSize(product: PdpProductSignal): string | undefined {
  const text = cleanSignal([product.name, product.originalName].filter(Boolean).join(" "));
  return text.match(/\b\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\b/i)?.[0];
}

function extractProductSku(product: PdpProductSignal, sourceUrl?: string): string | undefined {
  return first(unique([
    extractSkuFromSourceUrl(sourceUrl),
    ...[
      product.description,
      product.originalName,
      ...product.sourceTexts
    ].flatMap(extractSkuFromText)
  ].filter((value): value is string => Boolean(value))));
}

function extractSkuFromSourceUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }
  try {
    const url = new URL(sourceUrl);
    const priorityKeys = [
      "sku",
      "productcode",
      "prodcode",
      "prdcode",
      "itemcode",
      "onlineprodcode",
      "goodsno",
      "goodsid",
      "itemno",
      "itemid",
      "modelno",
      "modelnumber",
      "mpn"
    ];
    const params = Array.from(url.searchParams.entries())
      .map(([key, value]) => [key.replace(/[^a-z0-9]/gi, "").toLowerCase(), value] as const);
    for (const key of priorityKeys) {
      const value = params.find(([paramKey]) => paramKey === key)?.[1];
      const sku = sanitizeSku(value);
      if (sku) {
        return sku;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractSkuFromText(value?: string): string[] {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return [];
  }
  const matches = Array.from(text.matchAll(
    /(?:\bsku\b|\bproduct\s*code\b|\bitem\s*code\b|\bmodel\s*(?:no|number)\b|\bmpn\b|상품\s*(?:코드|번호)|제품\s*코드|품번)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]{3,64})/gi
  ));
  return unique(matches.map((match) => sanitizeSku(match[1])).filter((sku): sku is string => Boolean(sku)));
}

function sanitizeSku(value?: string): string | undefined {
  const sku = cleanSignal(value ?? "").replace(/[^\p{L}\p{N}._-]/gu, "");
  if (!sku || sku.length < 4 || sku.length > 64 || /^(?:product|item|model|code|번호|상품|제품)$/i.test(sku)) {
    return undefined;
  }
  return sku;
}

function extractCurrentVariantLabel(product: PdpProductSignal): string | undefined {
  const size = extractCurrentVariantSize(product);
  const qualifiers = Array.from(cleanSignal([product.name, product.originalName].filter(Boolean).join(" ")).matchAll(/\[([^\]]{1,36})\]/g))
    .map((match) => cleanSignal(match[1] ?? ""))
    .filter(isVariantOrCommerceToken)
    .filter((token) => !/\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|매|개|입)/i.test(token));
  return formatDescriptionList(unique([...qualifiers, size].filter((value): value is string => Boolean(value))), "ko-KR", 3);
}

function isPercentOrCouponPriceContext(text: string, raw: string): boolean {
  const index = text.indexOf(raw);
  if (index < 0) {
    return false;
  }
  const window = text.slice(Math.max(0, index - 12), Math.min(text.length, index + raw.length + 12));
  return /%/.test(raw) || /쿠폰|적립|point|coupon|reward/i.test(window);
}

function normalizePriceCurrency(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  const symbolMap: Record<string, string> = {
    "$": "USD",
    "US$": "USD",
    "£": "GBP",
    "¥": "JPY",
    "₩": "KRW",
    "€": "EUR"
  };
  if (symbolMap[normalized]) {
    return symbolMap[normalized];
  }
  return /^[A-Z]{3}$/.test(normalized) ? normalized : undefined;
}

function inferCurrencyForMarket(market: string | undefined, locale: PdpGeoLocale): string | undefined {
  const key = (market ?? locale.split("-")[1] ?? "").toUpperCase();
  const map: Record<string, string> = {
    US: "USD",
    GB: "GBP",
    UK: "GBP",
    KR: "KRW",
    JP: "JPY"
  };
  return map[key];
}

function normalizeOfferPriceAmount(raw: string, amount: number | undefined, currency: string | undefined): number | undefined {
  const parsed = amount ?? Number(raw.replace(/[^\d.-]+/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || !currency) {
    return undefined;
  }
  const hasDecimalOrCurrencySymbol = /[.,]\d{1,2}\b|[$£€¥₩]|(?:usd|gbp|eur|jpy|krw)\b/i.test(raw);
  const zeroDecimalCurrencies = new Set(["KRW", "JPY"]);
  const decimalCurrency = !zeroDecimalCurrencies.has(currency);
  const normalized = decimalCurrency && !hasDecimalOrCurrencySymbol && Number.isInteger(parsed) && parsed >= 1000
    ? parsed / 100
    : parsed;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return undefined;
  }
  return decimalCurrency ? Number(normalized.toFixed(2)) : Math.round(normalized);
}

function createAggregateRatingSchema(product: PdpProductSignal): JsonObject | undefined {
  const ratingValue = product.reviews.rating;
  const reviewCount = product.reviews.reviewCount;
  if (typeof ratingValue !== "number" || ratingValue <= 0 || ratingValue > 5 || typeof reviewCount !== "number" || reviewCount <= 0) {
    return undefined;
  }
  return {
    "@type": "AggregateRating",
    ratingValue,
    reviewCount
  };
}

function createAdditionalProperties(
  product: PdpProductSignal,
  usageInstructions: string[],
  locale: PdpGeoLocale,
  contentPlan?: PdpGeoContentPlan
): JsonObject[] {
  const claimSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const ingredientEffectDetail = createIngredientEffectDetailProperty(product, locale, claimSentences[0]);
  const reviewUseFeelContext = hasPublicReviewEvidence(product, locale) ? createReviewUseFeelProperty(product, locale) : undefined;
  const modelPlannedCepProperties = createModelPlannedCepProperties(contentPlan);
  const reviewDerivedCepProperties = contentPlan?.mode === "model"
    ? []
    : createReviewDerivedCepProperties(product, locale);
  const reviewDerivedQueryProperties = contentPlan?.mode === "model"
    ? []
    : createReviewDerivedQueryProperties(product, locale);
  const entries: ProductAdditionalPropertyEntry[] = [
    { name: "Target customer", value: createTargetCustomerProperty(product, locale) },
    { name: "Recommended skin type", value: inferRecommendedSkinType(product, locale) },
    { name: "Key benefit", value: selectPublicPrimaryBenefit(product, locale) },
    { name: "Key efficacy", value: createKeyEfficacyProperty(product, locale) },
    { name: "Key ingredients", value: selectLocalizedKeyIngredients(product, locale, 5).join(", ") },
    { name: "Key ingredients and technologies", value: createKeyIngredientTechnologyProperty(product, locale) },
    { name: "Ingredient/effect detail", value: formatClaimSentence(ingredientEffectDetail, locale) },
    { name: "Functional certification", value: createFunctionalCertificationProperty(product, locale) },
    { name: "Texture and finish", value: selectTextureFinishSignal(product, locale) },
    { name: "Brand science", value: createBrandScienceProperty(product, locale) },
    { name: "Usage", value: formatUsagePropertyValue(usageInstructions, locale) },
    { name: "Routine synergy", value: createRoutineSynergyProperty(product, locale) },
    { name: "Customer review context", value: formatClaimSentence(reviewUseFeelContext, locale) },
    ...modelPlannedCepProperties,
    ...reviewDerivedCepProperties,
    ...reviewDerivedQueryProperties,
    { name: "Consumer satisfaction", value: createConsumerSatisfactionProperty(product, locale) },
    { name: "Reported details", value: createReportedDetailsProperty(product, locale) },
    { name: "Clinical result summary", value: createClinicalResultSummaryProperty(product, locale) },
    { name: "Variant comparison", value: selectVariantComparisonSignal(product, locale) },
    { name: "Renewal guidance", value: createRenewalGuidanceProperty(product, locale) },
    { name: "Gift suitability", value: createGiftSuitabilityProperty(product, locale) },
    { name: "Options", value: product.options.slice(0, 5).join(", ") }
  ];

  return entries.flatMap((entry) => {
    const cleanValue = entry.value ? sanitizeProductSchemaPropertyText(entry.name, entry.value, locale) : undefined;
    if (!cleanValue || !isUsefulSchemaPropertyValue(entry.name, cleanValue)) {
      return [];
    }
    const propertyValue: JsonObject = {
      "@type": "PropertyValue",
      name: entry.name,
      value: cleanValue
    };
    if (entry.propertyID) {
      propertyValue.propertyID = entry.propertyID;
    }
    return [propertyValue];
  });
}

/**
 * Publishes only the factual portion of an accepted model CEP plan. Query-only
 * associations remain in diagnostics and never become Product claims.
 */
function createModelPlannedCepProperties(contentPlan?: PdpGeoContentPlan): ProductAdditionalPropertyEntry[] {
  if (contentPlan?.mode !== "model") {
    return [];
  }
  return contentPlan.cep
    .map((cep) => unique([cep.situation, cep.need, cep.constraint].map(cleanSignal).filter(Boolean)))
    .filter((parts) => parts.length > 0)
    .filter((parts, index, items) => items.findIndex((candidate) => normalizeFaqQuestionKey(candidate.join(" ")) === normalizeFaqQuestionKey(parts.join(" "))) === index)
    .slice(0, 3)
    .map((parts) => ({
      name: "Customer situation",
      propertyID: "customerSituation",
      value: parts.join(" · ")
    }));
}

function createKeyEfficacyProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const benefits = selectClaimedBenefitSignals(product, locale).slice(0, 6);
  return benefits.length > 1 ? formatDescriptionList(benefits, locale, 6) : undefined;
}

function createTargetCustomerProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const recommendedSkinType = inferRecommendedSkinType(product, locale);
  return recommendedSkinType
    ? locale === "ko-KR" ? `${recommendedSkinType} 고객` : recommendedSkinType
    : undefined;
}

function createKeyIngredientTechnologyProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 6);
  const text = allProductEvidenceText(product);
  const technologySignals = locale === "ko-KR"
    ? [extractKoreanFormulaTechnologyPhrase(text)].filter((value): value is string => Boolean(value))
    : [];
  const ingredientsAndTechnologies = unique([...ingredients, ...technologySignals]).slice(0, 6);
  if (ingredientsAndTechnologies.length === 0) {
    return undefined;
  }
  const hasTechnologyContext = /technology|formula|complex|capsule|peptide|retinol|derivative|active|proprietary|patent|기술|포뮬러|복합체|캡슐|펩타이드|레티놀|유도체|독자|특허/i.test(text);
  if (!hasTechnologyContext && ingredientsAndTechnologies.length < 3) {
    return undefined;
  }
  const ingredientPhrase = formatDescriptionList(ingredientsAndTechnologies, locale, 6);
  const benefitPhrase = formatDescriptionList(selectClaimedBenefitSignals(product, locale).slice(0, 3), locale, 3);
  const supportedLink = selectFaqIngredientBenefitLink(product, locale);
  if (!ingredientPhrase) {
    return undefined;
  }
  if (locale === "ko-KR") {
    if (supportedLink) {
      return `${ingredientPhrase} 성분/기술이 포함되어 있습니다. ${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다.`;
    }
    return benefitPhrase
      ? `${ingredientPhrase} 성분/기술이 포함되어 있으며, 상품 정보에서 ${appendKoreanSubjectParticle(benefitPhrase)} 확인됩니다.`
      : `${ingredientPhrase} 성분/기술이 핵심 포뮬러 정보입니다.`;
  }
  return supportedLink
    ? `${ingredientPhrase} are included in the formula. Source evidence links ${supportedLink.ingredient} with ${supportedLink.benefit}.`
    : benefitPhrase ? `${ingredientPhrase} are included in the formula, while product information identifies ${benefitPhrase}.` : `${ingredientPhrase} are highlighted as formula or technology details.`;
}

function formatKoreanIngredientBenefitContext(value: string): string {
  const text = cleanSignal(value)
    .replace(/\s+케어\s+케어/g, " 케어")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "효능 맥락";
  }
  return /(?:케어|개선|보습|수분감|피부결|피부\s*장벽|장벽|탄력|주름|광채)$/u.test(text)
    ? text
    : `${text} 케어`;
}

function createFunctionalCertificationProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  return formatDescriptionList(selectFunctionalCertificationSignals(product, locale), locale, 3);
}

function selectFunctionalCertificationSignals(product: PdpProductSignal, locale: PdpGeoLocale, limit = 3): string[] {
  const evidenceText = allProductEvidenceText(product);
  const koreanDirectSignals = locale === "ko-KR" ? [
    /극민감\s*(?:피부\s*)?테스트(?:를)?\s*완료/i.test(evidenceText) ? "극민감 피부 테스트 완료" : undefined,
    /민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "민감 피부 자극 테스트 완료" : undefined,
    /피부과\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "피부과 테스트 완료" : undefined,
    /여드름성\s*피부\s*사용\s*적합\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "여드름성 피부 사용 적합 테스트 완료" : undefined,
    /알러지\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "알러지 테스트 완료" : undefined,
    /인체\s*안자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "인체 안자극 테스트 완료" : undefined,
    /소아과\s*피부\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "소아과 피부 테스트 완료" : undefined,
    /피부\s*내성\s*테스트(?:를)?\s*(?:완료|완료했|완료한|tested)?/i.test(evidenceText) ? "피부 내성 테스트 완료" : undefined,
    /하이포\s*알러(?:지|제닉)\s*테스트(?:를)?\s*(?:완료|완료했|완료한)?/i.test(evidenceText) ? "하이포알러제닉 테스트 완료" : undefined,
    /민감\s*피부\s*사용\s*적합\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "민감 피부 사용 적합 테스트 완료" : undefined,
    !/민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트(?:를)?\s*완료/i.test(evidenceText)
      && /피부\s*자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "피부 자극 테스트 완료" : undefined,
    /저자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "저자극 테스트 완료" : undefined
  ] : [];
  const directSignals = [
    ...koreanDirectSignals,
    /dermatolog(?:ist|ically)\s*tested/i.test(evidenceText) ? fallback(locale, {
      "ko-KR": "피부과 테스트 완료",
      "ja-JP": "皮膚科テスト済み",
      "en-US": "Dermatologically tested",
      "en-GB": "Dermatologically tested"
    }) : undefined,
    /hypoallergenic(?:ally)?\s*tested/i.test(evidenceText) ? fallback(locale, {
      "ko-KR": "하이포알러지 테스트 완료",
      "ja-JP": "低刺激性テスト済み",
      "en-US": "Hypoallergenic tested",
      "en-GB": "Hypoallergenic tested"
    }) : undefined,
    /non[-\s]?comedogenic(?:ally)?\s*tested/i.test(evidenceText) ? fallback(locale, {
      "ko-KR": "논코메도제닉 테스트 완료",
      "ja-JP": "ノンコメドジェニックテスト済み",
      "en-US": "Non-comedogenic tested",
      "en-GB": "Non-comedogenic tested"
    }) : undefined
  ].filter((value): value is string => Boolean(value));

  const sentenceSignals = selectSourceSentencesByIntent(product, certificationOrTestPattern(), locale, 4)
    .map((sentence) => normalizeFunctionalCertificationSentence(sentence, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isQuantifiedClinicalResultSentence(value));

  return dedupeFunctionalCertificationSignals([
    ...directSignals,
    ...selectAtomicFunctionalCertificationValues(evidenceText, locale),
    ...sentenceSignals
  ]).slice(0, limit);
}

function dedupeFunctionalCertificationSignals(values: string[]): string[] {
  const selected: string[] = [];
  for (const value of unique(values.map(cleanSignal).filter(Boolean))) {
    const key = signalEntityKey(value).replace(/민감성/gu, "민감").replace(/대상/gu, "");
    if (selected.some((item) => signalEntityKey(item).replace(/민감성/gu, "민감").replace(/대상/gu, "") === key)) {
      continue;
    }
    if (/^피부\s*자극\s*테스트\s*완료$/u.test(value)
      && selected.some((item) => /민감\s*피부[^,]*자극\s*테스트\s*완료/u.test(item))) {
      continue;
    }
    selected.push(value);
  }
  return selected;
}

function normalizeFunctionalCertificationSentence(value: string, locale: PdpGeoLocale): string | undefined {
  const text = trimTrailingSentencePunctuation(sanitizeProductSchemaText(value, locale)
    .replace(/^네,\s*/u, "")
    .replace(/\s*\.,\s*/g, ". ")
    .replace(/\s+/g, " ")
    .trim());
  if (!text || /(?:후기|리뷰|review|rating|모이스처라이징|기본\s*보습|만족도가\s*높|사용\s*중단|콜라겐\s*발현율|비건|동물\s*실험|동물성\s*원료|동물유래|vegan|animal|cruelty)/i.test(text)) {
    return undefined;
  }
  if (isQuantifiedClinicalResultSentence(text) && !/(?:사용\s*적합|피부\s*자극|저자극|논코메도|하이포알러지|dermatolog|hypoallergenic|non[-\s]?comedogenic)/i.test(text)) {
    return undefined;
  }
  if (/민감\s*피부\s*사용\s*적합\s*테스트(?:를)?\s*완료/i.test(text)) {
    return "민감 피부 사용 적합 테스트 완료";
  }
  if (/피부\s*자극\s*테스트\s*완료/i.test(text)) {
    return "피부 자극 테스트 완료";
  }
  if (/저자극\s*테스트\s*완료/i.test(text)) {
    return "저자극 테스트 완료";
  }
  if (/피부\s*내성\s*테스트/i.test(text)) {
    return "피부 내성 테스트 완료";
  }
  if (/하이포\s*알러(?:지|제닉)\s*테스트/i.test(text)) {
    return "하이포알러제닉 테스트 완료";
  }
  if (locale === "ko-KR") {
    if (/극민감\s*테스트/i.test(text)) return "극민감 피부 테스트 완료";
    if (/피부과\s*테스트/i.test(text)) return "피부과 테스트 완료";
    if (/알러지\s*테스트/i.test(text)) return "알러지 테스트 완료";
    if (/인체\s*안자극\s*테스트/i.test(text)) return "인체 안자극 테스트 완료";
    if (/소아과\s*피부\s*테스트/i.test(text)) return "소아과 피부 테스트 완료";
    return undefined;
  }
  if (!/(?:테스트|시험|완료|완료했|완료한|tested|dermatolog|hypoallergenic|non[-\s]?comedogenic)/i.test(text)) {
    return undefined;
  }
  return truncateAtCompleteSentence(text, 140);
}

function createBrandScienceProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const signals = selectSourceSentencesByIntent(product, researchOrTechnologyPattern(), locale, 4)
    .map((value) => normalizeBrandScienceSignal(value, locale))
    .filter((value): value is string => Boolean(value));
  return formatDescriptionList(unique(signals).slice(0, 2), locale, 2);
}

function normalizeBrandScienceSignal(value: string, locale: PdpGeoLocale): string | undefined {
  const text = trimTrailingSentencePunctuation(normalizeInferencePublicText(sanitizeProductSchemaText(value, locale), locale)
    .replace(/\bNEW\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim());
  if (!text || !isNarrativeLocaleCompatible(text, locale) || isQuantifiedClinicalResultSentence(text) || isCommerceMetricArtifact(text)) {
    return undefined;
  }
  if (locale === "ko-KR") {
    const science = text.match(/(?:\d+\s*년\s*)?[^.!?。！？]{0,24}(?:인삼과학|피부과학|과학|연구)[^.!?。！？]{0,60}/)?.[0];
    const technology = text.match(/(?:진세노믹스|레티놀|펩타이드|콜라겐|사포닌|기술|포뮬러)[^.!?。！？]{0,60}/)?.[0];
    const candidate = cleanSignal(science ?? technology ?? truncateAtCompleteSentence(text, 120));
    const hasCompletePredicate = /(?:연구(?:했|한|하여|합니다|됩니다)|개발(?:했|한|하여|합니다|되었습니다)|적용(?:했|한|되어|됩니다)|설계(?:했|한|되어|됩니다)|구현(?:했|한|되어|됩니다)|담(?:았|은)|구성(?:했|된|됩니다)|기술|포뮬러|연구)$/u.test(candidate);
    if (!candidate
      || candidate.length < 12
      || candidate.length > 48 && !hasCompletePredicate
      || /(?:부터|대비|vs\.?)[^,.!?。！？]{18,}$/i.test(candidate)
      || /(?:통해|위해|대한|관한|부터|까지|및|과|와)$/u.test(candidate)
      || /^(?:기술|연구|포뮬러)\s+\d/u.test(candidate)
      || /^(?:기술|연구|포뮬러)(?:이|가|은|는)\s+/u.test(candidate)
      || /\d+(?:\.\d+)?\s*(?:시간|일|주|개월|년)[^,.!?。！？]{0,28}\d+(?:\.\d+)?\s*(?:시간|일|주|개월|년)/u.test(candidate)) {
      return undefined;
    }
    return candidate;
  }
  return truncateAtCompleteSentence(text, 140);
}

function isQuantifiedClinicalResultSentence(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(text)
    && /(?:임상|인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|결과|clinical|study|self[-\s]?assessment|instrumental|participants?|subjects?|women|men|users?)/i.test(text);
}

function certificationOrTestPattern(): RegExp {
  return /(?:certif(?:ied|ication)|approved|tested|test\s+completed|dermatolog(?:ist|ically)|hypoallergenic|non[-\s]?comedogenic|clinical\s+test|functional\s+cosmetic|인증|승인|기능성|테스트|시험|완료|적합|저자극|논코메도|하이포알러지)/i;
}

function researchOrTechnologyPattern(): RegExp {
  return /(?:research|science|scientific|technology|proprietary|patent|patented|formula|complex|method|heritage|years?\s+of|연구|과학|기술|특허|독자|포뮬러|복합체|방식|헤리티지|\d+\s*년)/i;
}

function selectSourceSentencesByIntent(
  product: PdpProductSignal,
  pattern: RegExp,
  locale: PdpGeoLocale,
  limit: number
): string[] {
  return unique([
    product.description,
    ...product.sourceTexts,
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap(splitEvidenceIntoSentenceCandidates)
    .map((value) => sanitizeProductSchemaText(value, locale))
    .filter((value) => value.length >= 6 && value.length <= 180)
    .filter((value) => pattern.test(value))
    .filter((value) => !isCommerceMetricArtifact(value))
    .filter((value) => !hasRawAllCapsEvidenceLead(value))
    .filter(isUsefulPublicListValue))
    .slice(0, limit);
}

function splitEvidenceIntoSentenceCandidates(value: string): string[] {
  const text = cleanSignal(value);
  if (!text) {
    return [];
  }
  return text
    .split(/(?<=[.!?。！？])\s+|\n+|[|]/u)
    .map(cleanSignal)
    .filter(Boolean);
}

function hasRawAllCapsEvidenceLead(value: string): boolean {
  return /^[A-Z0-9™®().,\s'&/-]{12,}\s*[-:]/.test(value.trim());
}

function createRoutineSynergyProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const routine = selectRoutineSynergySignal(product, locale);
  if (!routine) {
    return undefined;
  }
  if (locale === "ko-KR") {
    return routine;
  }
  const usage = first(selectUsageInstructions(product));
  return usage ? `${capitalizeFirst(routine)}; usage guidance says to ${lowercaseSentenceStart(trimTrailingSentencePunctuation(usage))}.` : capitalizeFirst(routine);
}

function createConsumerSatisfactionProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const reviewPhrase = hasPublicReviewEvidence(product, locale) ? formatDescriptionList(selectPublicReviewKeywords(product, locale).slice(0, 5), locale, 5) : undefined;
  const rating = product.reviews.rating && product.reviews.reviewCount
    ? fallback(locale, {
      "ko-KR": `평점 ${formatRatingValue(product.reviews.rating)}/5 및 리뷰 ${product.reviews.reviewCount}개`,
      "ja-JP": `評価${formatRatingValue(product.reviews.rating)}/5、レビュー${product.reviews.reviewCount}件`,
      "en-US": `${formatRatingValue(product.reviews.rating)}/5 rating across ${product.reviews.reviewCount} reviews`,
      "en-GB": `${formatRatingValue(product.reviews.rating)}/5 rating across ${product.reviews.reviewCount} reviews`
    })
    : undefined;
  return formatDescriptionList([rating, reviewPhrase].filter((value): value is string => Boolean(value)), locale, 2);
}

function formatRatingValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function createClinicalResultSummaryProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const reported = createReportedDetailsProperty(product, locale);
  if (!reported || !/(?:%|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|테스트|시험|결과|clinical|study|self-assess|instrumental|participants?|users?|subjects?)/i.test(reported)) {
    return undefined;
  }
  return reported;
}

function createRenewalGuidanceProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  if (!/(?:리뉴얼|renewal|renewed|replacement|replaces|discontinued|단종|대체)/i.test(text)) {
    return undefined;
  }
  return fallback(locale, {
    "ko-KR": "리뉴얼, 대체, 또는 단종 관련 선택 안내가 상품 정보에 포함되어 있습니다",
    "ja-JP": "リニューアル、代替、または終売に関する選択情報を含みます",
    "en-US": "Renewal, replacement, or discontinued-product guidance is included in the product information",
    "en-GB": "Renewal, replacement, or discontinued-product guidance is included in the product information"
  });
}

function createGiftSuitabilityProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  if (!/(?:선물|기프트|gift|present|포장|gift\s*set)/i.test(text)) {
    return undefined;
  }
  return fallback(locale, {
    "ko-KR": "선물 또는 기프트 구매 맥락이 상품 정보에 포함되어 있습니다",
    "ja-JP": "ギフト購入の文脈を含みます",
    "en-US": "Gift or present-purchase context is included",
    "en-GB": "Gift or present-purchase context is included"
  });
}

function sanitizeProductSchemaPropertyText(name: string, value: string, locale: PdpGeoLocale): string {
  if (name === "Key ingredients") {
    return cleanSignal(value)
      .replace(/\\[rn]/g, " ")
      .replace(/\s+([,.])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }
  const sanitized = sanitizeProductSchemaText(value, locale);
  return compactSchemaPropertyText(name, sanitized, locale);
}

function compactSchemaPropertyText(name: string, value: string, locale: PdpGeoLocale): string {
  const text = trimTrailingSentencePunctuation(cleanSignal(value));
  if (!text) {
    return "";
  }
  if (/^Functional certification$/i.test(name)) {
    const certifications = selectAtomicFunctionalCertificationValues(text, locale);
    return formatDescriptionList(unique(certifications), locale, 3) ?? "";
  }
  if (/^Brand science$/i.test(name)) {
    return truncateAtCompleteSentence(text.replace(/\bNEW\b/gi, " ").replace(/\s+/g, " "), 160);
  }
  if (/^Customer review context$/i.test(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 180 : 220);
  }
  if (isReviewDerivedQueryPropertyName(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 420 : 520);
  }
  if (/^Clinical result summary$/i.test(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 360 : 420);
  }
  if (/^Reported details$/i.test(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 520 : 760);
  }
  if (/^Ingredient\/effect detail$/i.test(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 360 : 420);
  }
  return text;
}

function isReviewDerivedQueryPropertyName(name: string): boolean {
  return /^(?:간접 고객 질문|직접 상품 질문|間接顧客質問|直接商品質問|Indirect customer question|Direct product question)/i.test(name)
    || /(?:\?|？|인가요|인가요\?|무엇인가요|어떤\s+.+선택하면\s+좋나요|どの.+ですか|what\b.+\?|which\b.+\?|how\b.+\?)/i.test(name);
}

function selectAtomicFunctionalCertificationValues(value: string, locale: PdpGeoLocale): string[] {
  if (locale === "ko-KR") {
    const text = value.replace(/\s+/g, " ").trim();
    return [
      /극민감\s*(?:피부\s*)?테스트\s*완료/u.test(text) ? "극민감 피부 테스트 완료" : undefined,
      /민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text) ? "민감 피부 자극 테스트 완료" : undefined,
      /피부과\s*테스트\s*완료/u.test(text) ? "피부과 테스트 완료" : undefined,
      /여드름성\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "여드름성 피부 사용 적합 테스트 완료" : undefined,
      /알러지\s*테스트\s*완료/u.test(text) ? "알러지 테스트 완료" : undefined,
      /인체\s*안자극\s*테스트\s*완료/u.test(text) ? "인체 안자극 테스트 완료" : undefined,
      /소아과\s*피부\s*테스트\s*완료/u.test(text) ? "소아과 피부 테스트 완료" : undefined,
      /피부\s*내성\s*테스트\s*완료/u.test(text) ? "피부 내성 테스트 완료" : undefined,
      /민감\s*성?\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "민감성 피부 사용 적합 테스트 완료" : undefined,
      /민감\s*피부\s*대상\s*사용성\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 사용성 테스트 완료" : undefined,
      /민감\s*피부\s*대상\s*피부\s*자극\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 피부 자극 테스트 완료" : undefined,
      !/민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text)
        && /피부\s*자극\s*테스트\s*완료/u.test(text) ? "피부 자극 테스트 완료" : undefined,
      /저자극\s*테스트\s*완료/u.test(text) ? "저자극 테스트 완료" : undefined,
      /안\s*자극\s*대체\s*시험\s*완료/u.test(text) ? "안자극 대체 시험 완료" : undefined,
      /하이포\s*알러(?:지|제닉)\s*테스트\s*완료/u.test(text) || /하이포알러(?:지|제닉)\s*테스트\s*완료/u.test(text) ? "하이포알러제닉 테스트 완료" : undefined,
      /논코메도제닉\s*테스트\s*완료/u.test(text) ? "논코메도제닉 테스트 완료" : undefined
    ].filter((item): item is string => Boolean(item));
  }

  return value
    .split(/\s*,\s*|[.。]\s*/)
    .map(cleanSignal)
    .filter(Boolean)
    .filter((item) => /(?:use\s*suitability|skin\s*irritation|low\s*irritation|dermatolog|hypoallergenic|non[-\s]?comedogenic|tested)/i.test(item))
    .filter((item) => !isQuantifiedClinicalResultSentence(item));
}

function formatUsagePropertyValue(usageInstructions: string[], locale: PdpGeoLocale): string | undefined {
  const steps = uniqueUsageSteps(usageInstructions)
    .map((step) => stripLeadingUsageStepMarkers(normalizeUsageInstruction(step)))
    .filter(isUsageInstruction)
    .slice(0, 4);
  if (steps.length === 0) {
    return undefined;
  }
  if (steps.length === 1) {
    return steps[0];
  }
  if (locale === "ko-KR") {
    return steps.map((step, index) => `${index + 1}단계: ${step}`).join("; ");
  }
  if (locale === "ja-JP") {
    return steps.map((step, index) => `${index + 1}段階: ${step}`).join("; ");
  }
  return steps.map((step, index) => `Step ${index + 1}: ${step}`).join("; ");
}

function createIngredientEffectDetailProperty(product: PdpProductSignal, locale: PdpGeoLocale, fallbackSentence?: string): string | undefined {
  const ingredients = selectLocalizedKeyIngredients(product, locale, 3);
  const benefits = selectClaimedBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 4);
  const customerContext = inferTargetCustomer(product, locale);
  const supportedLink = selectFaqIngredientBenefitLink(product, locale);

  if (ingredientPhrase && benefitPhrase) {
    if (locale === "ko-KR") {
      const linkSentence = supportedLink
        ? `${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다`
        : undefined;
      return compactSentence([
        `${ingredientPhrase} 성분/기술이 포함되어 있습니다`,
        `${appendKoreanSubjectParticle(benefitPhrase)} 필요한 ${customerContext}의 제품 선택에 참고할 수 있습니다`,
        linkSentence
      ]);
    }
    if (locale === "ja-JP") {
      return supportedLink
        ? `${supportedLink.ingredient}は${supportedLink.benefit}を支え、${customerContext}の選択基準をより明確にします`
        : `${ingredientPhrase}を配合し、商品情報では${benefitPhrase}が確認できます。${customerContext}が比較する際の参考になります`;
    }
    return supportedLink
      ? `The formula uses ${supportedLink.ingredient} to support ${supportedLink.benefit}, making the source evidence a clearer selection cue for ${customerContext}.`
      : `The formula includes ${ingredientPhrase}. Product information identifies ${benefitPhrase} as care benefits for ${customerContext}.`;
  }

  const detail = first(selectIngredientDetails(product, ingredients, 1));
  if (detail) {
    return detail;
  }
  return fallbackSentence;
}

function createReportedDetailsProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const descriptionEfficacyDetails = selectDescriptionEfficacyDetails(product, locale, 1)
    .map((detail) => locale === "ko-KR"
      ? detail.replace(/\s*이러한\s*효능·효과를\s*바탕으로[^.!?。！？]+(?:적합합니다)[.!?。！？]?/u, "").trim()
      : detail)
    .map((detail) => trimTrailingSentencePunctuation(detail))
    .filter((value): value is string => Boolean(value));
  const clinicalSummary = createStructuredClinicalEvidenceSummary(product, locale);
  if (clinicalSummary) {
    const clinicalDetail = trimTrailingSentencePunctuation(clinicalSummary);
    const preferGroupedDescription = locale === "ko-KR"
      && descriptionEfficacyDetails.some(hasKoreanGroupedEfficacyNarrative);
    const effectiveClinicalDetail = preferGroupedDescription ? undefined : clinicalDetail;
    const selectedMetricTokens = reportedMetricTokens(effectiveClinicalDetail ?? descriptionEfficacyDetails.join(" "));
    const descriptionOnlyDetails = preferGroupedDescription
      ? descriptionEfficacyDetails
      : descriptionEfficacyDetails.filter((detail) =>
        [...reportedMetricTokens(detail)].some((token) => !selectedMetricTokens.has(token))
      );
    const ingredientPerformanceDetails = selectIngredientPerformanceReportedDetails(product, locale, 1)
      .filter((detail) => [...reportedMetricTokens(detail)].some((token) => !selectedMetricTokens.has(token)));
    const clinicalAlreadyCovered = !effectiveClinicalDetail || descriptionOnlyDetails.some((detail) =>
      cleanSignal(detail).includes(cleanSignal(clinicalDetail))
      || reportedPropertyClausesOverlap(detail, clinicalDetail)
    );
    const combined = unique([
      ...descriptionOnlyDetails,
      clinicalAlreadyCovered ? undefined : effectiveClinicalDetail,
      ...ingredientPerformanceDetails
    ].filter((detail): detail is string => Boolean(detail))).slice(0, 3)
      .map((detail) => ensurePublicSentence(detail, locale))
      .join(" ");
    return appendReportedSampleScopeDisclosure(combined, locale);
  }

  const structuredMetricDetails = selectStructuredReportedMetricDetails(product, locale, 3)
    .map((detail) => trimTrailingSentencePunctuation(detail))
    .filter((value): value is string => Boolean(value));
  const reportedDetails = selectReportedDetails(product, 3);
  const formattedDetails = unique(reportedDetails
    .map((detail) => formatReportedDetailForProperty(formatReportedDetailItem(detail, locale), locale))
    .filter((value): value is string => Boolean(value))
    .map(trimTrailingSentencePunctuation));
  const preferGroupedDescription = locale === "ko-KR"
    && descriptionEfficacyDetails.some(hasKoreanGroupedEfficacyNarrative);
  const groupedIngredientPerformanceDetails = preferGroupedDescription
    ? selectIngredientPerformanceReportedDetails(product, locale, 1)
    : [];
  const detailCandidates = preferGroupedDescription
    ? [...descriptionEfficacyDetails, ...groupedIngredientPerformanceDetails]
    : [...descriptionEfficacyDetails, ...structuredMetricDetails, ...formattedDetails];
  const details = dedupeReportedPropertyClauses(detailCandidates
    .map((detail) => normalizeReportedPropertyClause(detail, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNonCitationEvidenceArtifact(value) && !isLowQualityPublicEvidenceText(value))
    .filter((value) => !/(?:상품\s*상세\s*테스트|확인\s*지표|평가\s*지표|product\s*detail\s*test)/iu.test(value))
    .filter(hasMinimumReportedEvidenceContext), 3);
  if (details.length > 0) {
    const value = details.map((detail) => ensurePublicSentence(detail, locale)).join(" ");
    return ensurePublicSentence(value, locale);
  }

  const fallbackEvidence = selectEvidenceSignal(product, locale);
  const formattedFallback = fallbackEvidence && isHardEvidenceSignal(fallbackEvidence)
    ? formatReportedDetailForProperty(formatReportedDetailItem(fallbackEvidence, locale), locale)
    : undefined;
  const contextualFallback = formattedFallback ? normalizeReportedPropertyClause(formattedFallback, locale) : undefined;
  if (contextualFallback && hasMinimumReportedEvidenceContext(contextualFallback)) {
    return ensurePublicSentence(contextualFallback, locale);
  }

  return createSimpleReportedMetricProperty(product, locale);
}

function selectIngredientPerformanceReportedDetails(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  limit: number
): string[] {
  const candidates = unique([
    ...product.metrics,
    ...product.effects,
    ...(product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [claim.sentence, claim.sourceText].filter((value): value is string => Boolean(value))),
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ]).filter(isIngredientPerformanceOnlyMetricText);
  return candidates
    .map((value) => locale === "ko-KR"
      ? formatKoreanIngredientPerformanceReportedDetail(value)
        ?? formatReportedDetailForProperty(formatReportedDetailItem(value, locale), locale)
      : formatReportedDetailForProperty(formatReportedDetailItem(value, locale), locale))
    .filter((value): value is string => Boolean(value))
    .map(trimTrailingSentencePunctuation)
    .slice(0, limit);
}

function formatKoreanIngredientPerformanceReportedDetail(value: string): string | undefined {
  const text = trimTrailingSentencePunctuation(cleanSignal(value));
  if (!isIngredientPerformanceOnlyMetricText(text) || !hasQuantifiedReportedSignal(text)) {
    return undefined;
  }
  const context = text.match(/(?:원료적\s*특성에\s*한한\s*)?(?:ex\s*vivo|in\s*vitro)\s*테스트/iu)?.[0];
  const claim = text
    .replace(/\s*(?:을|를|가|이)?\s*(?:보였다고\s*)?(?:제시|표시)되며[\s\S]*$/u, "")
    .replace(/\s*(?:해당\s*)?결과는[\s\S]*$/u, "")
    .replace(/\s+vs\.?\s+/giu, "과 ")
    .replace(/\s+/g, " ")
    .trim();
  if (!claim || !/(?:잔존|도달|전달|침투|흡수|방출)/u.test(claim)) {
    return undefined;
  }
  const result = `${appendKoreanSubjectParticle(claim)} 확인되었습니다`;
  return context && !claim.includes(context)
    ? `${context}에서 ${result}`
    : result;
}

function normalizeReportedPropertyClause(value: string, locale: PdpGeoLocale): string | undefined {
  if (locale === "ko-KR") {
    const compoundNarrative = createKoreanCompoundEfficacyNarrative(value);
    if (compoundNarrative) {
      return trimTrailingSentencePunctuation(compoundNarrative);
    }
  }
  const formatted = formatReportedDetailForProperty(value, locale);
  if (!formatted) return undefined;
  const text = trimTrailingSentencePunctuation(cleanSignal(formatted))
    .replace(/^(?:확인\s*지표|확인\s*근거|측정\s*결과|시험\s*결과|reported\s*result|consumer\s*assessment)\s*:\s*/i, "")
    .replace(/^(?:또한|also)\s*[,，:]?\s*/i, "")
    .replace(/표기되어\s*있다(?=[.!?。！？]|$)/gu, "표기되어 있습니다")
    .replace(/제시된다(?=[.!?。！？]|$)/gu, "제시됩니다")
    .replace(/설명된다(?=[.!?。！？]|$)/gu, "설명됩니다")
    .replace(/표시된다(?=[.!?。！？]|$)/gu, "표시됩니다")
    .trim();
  return text || undefined;
}

function dedupeReportedPropertyClauses(values: string[], limit: number): string[] {
  const selected: string[] = [];
  for (const value of unique(values)) {
    if (selected.some((existing) => reportedPropertyClausesOverlap(existing, value))) continue;
    selected.push(value);
    if (selected.length >= limit) break;
  }
  return selected;
}

function reportedPropertyClausesOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => cleanSignal(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}%]+/gu, " ").trim();
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText)) return true;
  const metricTokens = (value: string) => new Set(Array.from(value.matchAll(/\d+(?:[.,]\d+)?\s*(?:%|％|배)/gu)).map((match) => match[0].replace(/\s+/g, "")));
  const sharedMetric = [...metricTokens(left)].some((token) => metricTokens(right).has(token));
  if (!sharedMetric) return false;
  const contextTokens = (value: string) => new Set(normalize(value).split(" ").filter((token) => token.length >= 2 && !/^\d/.test(token)));
  const leftContext = contextTokens(left);
  const rightContext = contextTokens(right);
  const overlap = [...leftContext].filter((token) => rightContext.has(token)).length;
  return overlap >= 2;
}

function reportedMetricTokens(value: string): Set<string> {
  return new Set(Array.from(value.matchAll(/[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배)/gu))
    .map((match) => match[0].replace(/\s+/g, "")));
}

function appendReportedSampleScopeDisclosure(value: string, locale: PdpGeoLocale): string {
  const text = trimTrailingSentencePunctuation(cleanSignal(value));
  if (!text || !hasQuantifiedReportedSignal(text) || hasReportedSampleScope(text)) {
    return ensurePublicSentence(text, locale);
  }
  const disclosure = fallback(locale, {
    "ko-KR": "원문 공개 범위에서 시험 대상/표본 수는 확인되지 않습니다",
    "ja-JP": "公開されている原文の範囲では試験対象/サンプル数は確認できません",
    "en-US": "The public source text does not disclose the test audience or sample size",
    "en-GB": "The public source text does not disclose the test audience or sample size"
  });
  return ensurePublicSentence(`${text}. ${disclosure}`, locale);
}

function hasReportedSampleScope(value: string): boolean {
  return /(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?|respondents?|people)|(?:시험|조사|평가)\s*대상|민감\s*피부\s*대상|대상자|참여자|사용자|응답자|여성|남성|표본|sample|audience|participants?|subjects?|respondents?)/i.test(value)
    || /(?:시험\s*대상|조사\s*대상|표본|sample|audience|participants?|subjects?).{0,32}(?:확인되지|확인\s*불가|미공개|명시되지|not\s+disclosed|not\s+stated|not\s+specified)/i.test(value);
}

function createSimpleReportedMetricProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const metric = first([
    ...product.metrics,
    ...product.effects,
    ...product.benefits
  ]
    .map((value) => trimTrailingSentencePunctuation(sanitizeProductSchemaText(value, locale)))
    .filter((value) => hasMinimumReportedEvidenceContext(value) && !isCommerceMetricArtifact(value) && !isQuestionLikeText(value)));
  if (!metric) {
    return undefined;
  }
	  const reported = (() => {
	    if (locale === "ko-KR") {
	      return createKoreanEvidenceResultSentence(metric);
	    }
    if (locale === "ja-JP") {
      return `${metric}。`;
    }
    return /^Reported result:/i.test(metric) ? ensurePublicSentence(metric, locale) : `Reported result: ${metric}.`;
  })();
  return ensurePublicSentence(reported, locale);
}

function createStructuredClinicalEvidenceSummary(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const semanticSummary = createSemanticClinicalEvidenceSummary(product, locale);
  if (semanticSummary) {
    return semanticSummary;
  }
  if (locale === "ko-KR") {
    const evidenceCandidates = unique([
      ...product.metrics,
      ...(product.semanticFacts?.evidenceSentences ?? []),
      ...(product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [claim.sentence, claim.sourceText].filter((value): value is string => Boolean(value))),
      ...product.effects,
      ...product.benefits,
      ...product.sourceTexts
    ])
      .filter(hasMinimumReportedEvidenceContext)
      .filter((value) => !isIngredientPerformanceOnlyMetricText(value));
    return first(evidenceCandidates
      .map(createKoreanClinicalEvidenceSummary)
      .filter((value): value is string => Boolean(value)));
  }
  return undefined;
}

function createSemanticClinicalEvidenceSummary(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const claims = (product.semanticFacts?.metricClaims ?? [])
    .filter((item) => hasSemanticClinicalClaimContext(item))
    .filter((item) => hasQuantifiedReportedSignal([item.label, item.value, item.unit, item.sentence, item.sourceText].filter(Boolean).join(" ")))
    .filter((item) => !isIngredientPerformanceOnlyMetricClaim(item))
    .map((claim, index) => ({ claim, index, score: scoreSemanticClinicalClaimForPublicSummary(claim) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ claim }) => claim)
    .slice(0, 3);
  if (claims.length === 0) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const summaries = claims
      .map(formatKoreanSemanticClinicalClaim)
      .filter((value): value is string => Boolean(value));
    const summary = summaries.length > 0
      ? summaries.map((value) => ensurePublicSentence(value.replace(/결과\s+결과/g, "결과"), locale)).join(" ")
      : undefined;
    return summary && isPublicSemanticClinicalSummary(summary) ? summary : undefined;
  }

  const formatted = claims
    .map((claim) => formatSemanticMetricClaim(claim, locale))
    .filter((value): value is string => Boolean(value));
  return formatted.length > 0 ? formatted.join(" ") : undefined;
}

function isIngredientPerformanceOnlyMetricClaim(claim: PdpSemanticMetricClaim): boolean {
  const text = cleanSignal([
    claim.label,
    claim.subject,
    claim.metric,
    claim.method,
    claim.comparator,
    claim.caveat,
    claim.sentence,
    claim.sourceText
  ].filter(Boolean).join(" "));
  return isIngredientPerformanceOnlyMetricText(text);
}

function isIngredientPerformanceOnlyMetricText(value: string): boolean {
  const text = cleanSignal(value);
  const hasIngredientOrFormulaSubject = /(?:원료|성분|제형|포뮬러|캡슐|세라마이드|ingredient|formula|formulation|capsule|ceramide)/iu.test(text);
  const hasMechanismOutcome = /(?:잔존|도달|전달|침투|흡수|방출|retention|delivery|penetration|absorption|release)/iu.test(text);
  const hasLabOrFormulaComparison = /(?:ex\s*vivo|in\s*vitro|원료(?:적\s*특성)?|ingredient[-\s]?only|비캡슐|제형\s*(?:비교|대비)|(?:formula|formulation|capsule)[^.!?。！？]{0,50}(?:versus|vs\.?|compared\s+with|comparison))/iu.test(text);
  const hasCustomerSkinOutcome = /(?:피부\s*수분량|보습량|손상\s*장벽|장벽\s*손상|피부\s*탄력|피부결|주름|진정|skin\s+hydration|moisture\s+level|barrier\s+damage|skin\s+elasticity|skin\s+texture|wrinkles?|soothing)/iu.test(text);
  return hasIngredientOrFormulaSubject
    && hasMechanismOutcome
    && hasLabOrFormulaComparison
    && !hasCustomerSkinOutcome;
}

function scoreSemanticClinicalClaimForPublicSummary(claim: PdpSemanticMetricClaim): number {
  const text = cleanSignal([
    claim.label,
    claim.subject,
    claim.metric,
    claim.method,
    claim.sample,
    claim.period,
    claim.timing,
    claim.baseline,
    claim.comparator,
    claim.institution,
    claim.sentence,
    claim.sourceText
  ].filter(Boolean).join(" "));
  return [
    /(?:인체\s*적용|자가\s*평가|소비자\s*평가|home\s+usage|self[-\s]?assessment|consumer\s+(?:study|survey)|participants?|subjects?|users?|women|men|\d+\s*명)/iu.test(text) ? 6 : 0,
    /(?:피부\s*수분|보습|장벽\s*(?:손상|회복|개선)|탄력|주름|피부결|진정|skin\s+hydration|moisture|barrier|firmness|elasticity|wrinkles?|fine\s+lines?|skin\s+texture|soothing)/iu.test(text) ? 4 : 0,
    /(?:사용|도포|적용)\s*(?:직후|후|\d+(?:\.\d+)?\s*(?:분|시간|일|주))|after\s+(?:use|application|\d+)/iu.test(text) ? 2 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function isPublicSemanticClinicalSummary(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 520 || hasFaqCitationNoise(text) || isCommerceMetricArtifact(text)) {
    return false;
  }
  if (/(?:REJUVENATING|CRÈME|자가\s*스코어링|자가스코어링|AGREED|12\.0%\s+10\.0%|8\.0%\s+6\.0%|4\.0%\s+2\.0%\s+0\.0%)/i.test(text)) {
    return false;
  }
  return hasCompleteReportedDetailContext(text);
}

function formatKoreanSemanticClinicalClaim(claim: PdpSemanticMetricClaim): string | undefined {
  const sourceSentence = trimTrailingSentencePunctuation(cleanSignal(claim.sentence ?? claim.sourceText ?? ""));
  const method = cleanSignal(claim.method ?? "")
    || sourceSentence.match(/(?:인체\s*적용\s*시험|임상\s*시험|자가\s*평가|소비자\s*평가|사용성\s*시험)/u)?.[0]
    || "";
  const sample = cleanSignal(claim.sample ?? "")
    || sourceSentence.match(/[^,，.!?。！？]{0,100}?(?:여성|남성|성인|대상자|참여자|사용자)?\s*\d+\s*명\s*(?:대상|참여)?/u)?.[0]
    || "";
  const period = cleanSignal(claim.period ?? claim.timing ?? "");
  const institution = cleanSignal(claim.institution ?? "");
  const timing = cleanSignal(claim.timing ?? "");
  const baseline = cleanSignal(claim.baseline ?? claim.comparator ?? "");
  const label = cleanSignal(claim.label ?? claim.subject ?? claim.metric ?? "");
  const value = cleanSignal([claim.value, claim.unit].filter(Boolean).join(""));
  const compoundNarrative = createKoreanCompoundEfficacyNarrative(sourceSentence);
  if (compoundNarrative) {
    return compoundNarrative;
  }
  const result = label && value
    ? `${timing ? `${timing} ` : ""}${label} ${baseline ? `${baseline} ` : ""}${value}${claim.direction ? ` ${claim.direction}` : ""}`
    : sourceSentence || label || value;
  // A measurement timing is not proof of a clinical study. Do not manufacture
  // a method or an undisclosed-sample label; incomplete atoms remain ordinary
  // measured results and can only be grouped when shared study evidence exists.
  if (!method || !sample) {
    return undefined;
  }
  const periodContext = period && !sourceSentence.includes(period) ? period : undefined;
  const context = [institution, method, sample, periodContext].filter(Boolean).join(", ");
  if (!result || !hasQuantifiedReportedSignal(result)) {
    return undefined;
  }
	  return createKoreanEvidenceResultSentence(context ? `${context} 기준 ${result}` : result);
}

function hasSemanticClinicalClaimContext(claim: PdpSemanticMetricClaim): boolean {
  const text = cleanSignal([
    claim.method,
    claim.sample,
    claim.period,
    claim.timing,
    claim.baseline,
    claim.comparator,
    claim.institution,
    claim.sentence,
    claim.sourceText
  ].filter(Boolean).join(" "));
  const hasMethod = /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)/i.test(text);
  const hasPopulation = /(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|participants?|subjects?)/i.test(text);
  const hasMeasuredOutcome = hasQuantifiedReportedSignal(text)
    && /(?:회복|개선|증가|감소|향상|완화|지속|improv|recover|increase|decrease|reduc|last)/iu.test(text);
  return hasMethod && hasPopulation && hasMeasuredOutcome;
}

function createKoreanClinicalEvidenceSummary(value: string): string | undefined {
  const text = cleanSignal(value);
  const compoundNarrative = createKoreanCompoundEfficacyNarrative(text);
  if (compoundNarrative) {
    return compoundNarrative;
  }
  if (!isQuantifiedClinicalResultSentence(text) || !hasMinimumReportedEvidenceContext(text)) {
    return undefined;
  }

  const sample = text.match(/(?:시험\s*대상|대상)\s*[:：]?\s*(?:만\s*)?\d{2}\s*[-~–—]\s*\d{2}\s*세\s*(?:여성|남성|성인|대상자|사용자|참여자)?\s*\d+\s*명/)?.[0]
    ?? text.match(/(?:만\s*)?\d{2}\s*[-~–—]\s*\d{2}\s*세\s*(?:여성|남성|성인|대상자|사용자|참여자)?\s*\d+\s*명/)?.[0]
    ?? text.match(/\d+\s*명\s*(?:대상|참여|사용자|여성|남성)/)?.[0];
  const period = text.match(/(?:시험\s*기간|기간)\s*[:：]?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/)?.[0]
    ?? text.match(/\d+(?:\.\d+)?\s*주\s*(?:사용|후|동안)|사용\s*중단\s*1\s*주\s*후/)?.[0];
  const method = text.match(/(?:인체\s*적용\s*시험|자가\s*평가|소비자\s*평가|in\s*vitro|ex\s*vivo)/i)?.[0];

  if (!method || !sample) {
    return undefined;
  }

  const wrinkleMetrics = extractKoreanWrinkleMetricGroups(text);
  const genericMetrics = wrinkleMetrics.length > 0 ? [] : extractKoreanEvidenceMetricClauses(text).slice(0, 4);
  const metricPhrase = wrinkleMetrics.length > 0 ? wrinkleMetrics.join(", ") : genericMetrics.join(", ");
  if (!metricPhrase || !/%/.test(metricPhrase)) {
    return undefined;
  }

  const context = [method, sample, period].filter(Boolean).join(", ");
	  const summary = createKoreanEvidenceResultSentence(`${context} 기준 ${metricPhrase}`);
	  return ensurePublicSentence(summary.replace(/결과\s+결과/g, "결과"), "ko-KR");
}

function extractKoreanWrinkleMetricGroups(value: string): string[] {
  const text = cleanSignal(value);
  const groups: string[] = [];
  const fineWrinkle = extractKoreanMetricGroup(text, /미세\s*주름\s*개선/u, ["이마", "미간", "눈가"]);
  const deepWrinkle = extractKoreanMetricGroup(text, /굵은\s*주름\s*개선/u, ["이마", "목", "팔자"]);
  if (fineWrinkle) {
    groups.push(`미세 주름 개선 ${fineWrinkle}`);
  }
  if (deepWrinkle) {
    groups.push(`굵은 주름 개선 ${deepWrinkle}`);
  }
  return groups;
}

function extractKoreanMetricGroup(text: string, startPattern: RegExp, labels: string[]): string | undefined {
  const start = text.search(startPattern);
  if (start < 0) {
    return undefined;
  }
  const segment = text.slice(start, start + 160);
  const metrics = labels.flatMap((label) => {
    const match = segment.match(new RegExp(`${label}\\s*(\\d+(?:\\.\\d+)?\\s*%)`, "u"));
    return match?.[1] ? [`${label} ${match[1].replace(/\s+/g, "")}`] : [];
  });
  return metrics.length > 0 ? metrics.join(", ") : undefined;
}

function formatReportedDetailItem(detail: string, locale: PdpGeoLocale): string | undefined {
  if (/(?:of\s+users?\s+had\s+visible\s+improvement|users?\s+had\s+visible\s+improvement)/i.test(detail)) {
    return formatClaimSentence(detail, locale);
  }
  return createEvidenceMetricFact(detail, locale) ?? formatClaimSentence(detail, locale);
}

function formatReportedDetailForProperty(value: string | undefined, locale: PdpGeoLocale): string | undefined {
  if (!value) {
    return undefined;
  }
  if (locale === "en-US" || locale === "en-GB") {
    return value.replace(/^Consumer assessment:\s*/i, "Reported result: ");
  }
  if (locale === "ko-KR") {
    const normalized = value
      .replace(/^네,\s*/u, "")
      .replace(/확인\s*지표/g, "시험 결과")
      .replace(/확인\s*근거/g, "시험 결과")
      .replace(/(.+?)\s+기준\s+시험\s*결과\s*:/g, "$1 결과:")
      .replace(/\s+/g, " ")
      .trim();
    if (isBrokenKoreanReportedDetail(normalized)) {
      return undefined;
    }
    return normalized;
  }
  return value;
}

function isBrokenKoreanReportedDetail(value: string): boolean {
  return /(?:1주\s*후\s*시간|후기가\s*많아요|모이스처라이징|기본\s*보습|만족도가\s*높|피부\s*노화지수\s*-\s*103\.5%|전문의|상담\s*후\s*사용)/i.test(value);
}

function createReviewUseFeelProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  if (locale === "ko-KR") {
    return createKoreanReviewUseFeelProperty(product);
  }
  if (locale !== "en-US" && locale !== "en-GB") {
    return undefined;
  }

  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
  const outcomePhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale), locale, 4);
  const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "product", locale);

  if (!reviewPhrase || !outcomePhrase) {
    return undefined;
  }

  return createEnglishReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase);
}

function createKoreanReviewUseFeelProperty(product: PdpProductSignal): string | undefined {
  const locale: PdpGeoLocale = "ko-KR";
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
  const outcomePhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale), locale, 4);
  const productType = localizeProductTypeForLocale(resolveProductType(product) ?? "제품", locale);

  if (!reviewPhrase || !outcomePhrase) {
    return undefined;
  }

  return createKoreanReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase);
}

type ReviewDerivedSearchQuery = {
  kind: "indirect" | "direct";
  question: string;
  keywords: string[];
  answer: string;
  source: PdpGeoInferredSearchQueryDiagnostic["source"];
  score: number;
};

function createReviewDerivedCepProperties(product: PdpProductSignal, locale: PdpGeoLocale): ProductAdditionalPropertyEntry[] {
  return createReviewDerivedIndirectSearchQueries(product, locale)
    .filter((query) => query.source === "review-derived-cep")
    .slice(0, 2)
    .map((query) => ({
      name: "Review-derived recommendation context",
      propertyID: "reviewDerivedRecommendationContext",
      value: query.answer
    }));
}

function createReviewDerivedSearchQueries(product: PdpProductSignal, locale: PdpGeoLocale): ReviewDerivedSearchQuery[] {
  const indirectQueries = createReviewDerivedIndirectSearchQueries(product, locale).slice(0, 3);
  const directQueries = createReviewDerivedDirectSearchQueries(product, locale).slice(0, 2);
  return uniqueReviewDerivedSearchQueries([
    ...indirectQueries.slice(0, 1),
    ...directQueries.slice(0, 1),
    ...indirectQueries.slice(1),
    ...directQueries.slice(1)
  ]).slice(0, 4);
}

function createReviewDerivedQueryProperties(product: PdpProductSignal, locale: PdpGeoLocale): ProductAdditionalPropertyEntry[] {
  return createReviewDerivedSearchQueries(product, locale)
    .slice(0, 4)
    .map((query) => ({
      name: createReviewDerivedQueryPropertyName(query),
      propertyID: createReviewDerivedQueryPropertyID(query),
      value: createReviewDerivedQueryPropertyValue(query)
    }))
    .filter((item) => Boolean(item.value));
}

function createReviewDerivedIndirectSearchQueries(product: PdpProductSignal, locale: PdpGeoLocale): ReviewDerivedSearchQuery[] {
  const target = cleanSignal(createTargetCustomerProperty(product, locale) ?? inferTargetCustomer(product, locale));
  const benefits = selectClaimedBenefitSignals(product, locale).slice(0, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 3);
  const productType = selectLocalizedSchemaProductType(product, locale);
  if (!target || !benefitPhrase || !isSpecificTargetCustomer(target, locale)) {
    return [];
  }

  const productName = createPublicProductEntityName(product);
  const supportedLink = selectFaqIngredientBenefitLink(product, locale);
  const reviewSignals = hasPublicReviewEvidence(product, locale)
    ? selectPublicReviewKeywords(product, locale).filter((value) => !isNegativeReviewSignalText(value)).slice(0, 3)
    : [];
  const reviewPhrase = formatDescriptionList(reviewSignals, locale, 3);
  const question = fallback(locale, {
    "ko-KR": `${formatKoreanReviewCepTarget(target) ?? "고객에게"} ${appendKoreanObjectParticle(benefitPhrase)} 돕는 ${appendKoreanTopicParticle(productType)} 무엇인가요?`,
    "ja-JP": `${target}に${benefitPhrase}をサポートする${productType}は何ですか？`,
    "en-US": `Which ${lowercaseEnglishProductType(productType)} supports ${benefitPhrase} for ${target}?`,
    "en-GB": `Which ${lowercaseEnglishProductType(productType)} supports ${benefitPhrase} for ${target}?`
  });
  const answer = locale === "ko-KR"
    ? compactSentence([
      `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(formatKoreanReviewCepTarget(target)?.replace(/에게$/u, "") ?? target)} 위한 ${appendKoreanInstrumentParticle(productType)}, ${appendKoreanObjectParticle(benefitPhrase)} 돕습니다`,
      supportedLink ? `${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다` : undefined,
      reviewPhrase ? `고객 리뷰에서는 ${appendKoreanSubjectParticle(formatKoreanListForSentence(reviewPhrase))} 반복됩니다` : undefined
    ])
    : locale === "ja-JP"
      ? compactSentence([
        `${productName}は${target}向けに${benefitPhrase}をサポートする${productType}です`,
        supportedLink ? `${supportedLink.ingredient}は${supportedLink.benefit}を支えます` : undefined,
        reviewPhrase ? `レビューでは${reviewPhrase}などの使用感が繰り返し見られます` : undefined
      ])
      : compactSentence([
        `${productName} is ${englishProductTypeWithArticle(productType)} for ${target} that supports ${benefitPhrase}`,
        supportedLink ? `${supportedLink.ingredient} supports ${supportedLink.benefit}` : undefined,
        reviewPhrase ? `Customer reviews repeatedly mention ${reviewPhrase}` : undefined
      ]);
  const keywords = selectReviewQueryCoreKeywords(product, locale, reviewSignals, target);
  return question && answer && keywords.length > 0 ? [{
    kind: "indirect",
    question,
    keywords,
    answer,
    source: reviewSignals.length > 0 ? "review-derived-cep" : "product-fact",
    score: 32 + benefits.length + keywords.length
  }] : [];
}

function createReviewDerivedDirectSearchQueries(product: PdpProductSignal, locale: PdpGeoLocale): ReviewDerivedSearchQuery[] {
  return [
    createIngredientBenefitDirectQuery(product, locale),
    createPositiveReviewUseFeelDirectQuery(product, locale)
  ]
    .filter((query): query is ReviewDerivedSearchQuery => Boolean(query))
    .sort((a, b) => b.score - a.score);
}

function createIngredientBenefitDirectQuery(product: PdpProductSignal, locale: PdpGeoLocale): ReviewDerivedSearchQuery | undefined {
  const ingredients = selectConciseFaqIngredientSignals(product, locale);
  const benefits = selectClaimedBenefitSignals(product, locale).slice(0, 3);
  if (ingredients.length === 0 || benefits.length === 0) {
    return undefined;
  }

  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 3);
  const productType = selectLocalizedSchemaProductType(product, locale);
  const directEntity = createDirectQueryEntityName(product);
  const productName = createPublicProductEntityName(product);
  if (!ingredientPhrase || !benefitPhrase) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const supportedLink = selectFaqIngredientBenefitLink(product, locale);
    return {
      kind: "direct",
      question: `${directEntity}의 주요 성분과 효능은 무엇인가요?`,
      keywords: selectReviewQueryCoreKeywords(product, locale, benefits, directEntity),
      answer: compactSentence(supportedLink ? [
        `${productName}에는 ${formatKoreanIngredientIncludedSubject(ingredientPhrase)} 포함되어 있습니다`,
        `${formatKoreanIngredientTopicPhrase(supportedLink.ingredient)} ${appendKoreanObjectParticle(supportedLink.benefit)} 뒷받침합니다`
      ] : [
        `${productName}에는 ${formatKoreanIngredientIncludedSubject(ingredientPhrase)} 포함되어 있습니다`,
        `${appendKoreanTopicParticle(benefitPhrase)} 이 제품의 주요 효능입니다`
      ]),
      source: "product-fact",
      score: 24 + ingredients.length + benefits.length
    };
  }

  return {
    kind: "direct",
    question: `What are the key ingredients and benefits of ${directEntity}?`,
    keywords: selectReviewQueryCoreKeywords(product, locale, benefits, directEntity),
    answer: compactSentence([
      `${productName} is ${englishProductTypeWithArticle(productType)} for shoppers comparing ${benefitPhrase}`,
      `The formula highlights ${ingredientPhrase}`
    ]),
    source: "product-fact",
    score: 24 + ingredients.length + benefits.length
  };
}

function selectConciseFaqIngredientSignals(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  const candidates = selectReviewCepIngredientSignals(product, locale);
  const concise = candidates.filter((value) => value.length <= 48 && !/[()[\]]/u.test(value));
  return (concise.length > 0 ? concise : candidates).slice(0, 2);
}

function createPositiveReviewUseFeelDirectQuery(product: PdpProductSignal, locale: PdpGeoLocale): ReviewDerivedSearchQuery | undefined {
  if (!hasPublicReviewEvidence(product, locale)) {
    return undefined;
  }

  const reviewKeywords = selectPublicReviewKeywords(product, locale)
    .map((value) => locale === "ko-KR" ? normalizeKoreanReviewSummaryTerm(value) : value)
    .filter((value): value is string => Boolean(value))
    .filter(isReviewDerivedQueryKeyword)
    .slice(0, 3);
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 3);
  if (reviewKeywords.length === 0 || benefits.length === 0) {
    return undefined;
  }

  const reviewPhrase = formatDescriptionList(reviewKeywords, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 3);
  const productType = selectLocalizedSchemaProductType(product, locale);
  const directEntity = createDirectQueryEntityName(product);
  const productName = createPublicProductEntityName(product);
  if (!reviewPhrase || !benefitPhrase) {
    return undefined;
  }

  if (locale === "ko-KR") {
    return {
      kind: "direct",
      question: `${directEntity} 리뷰에서 반복되는 사용감은 무엇인가요?`,
      keywords: selectReviewQueryCoreKeywords(product, locale, reviewKeywords, directEntity),
      answer: `${productName}의 긍정 리뷰에서는 ${appendKoreanSubjectParticle(formatKoreanListForSentence(reviewPhrase))} 반복되며, ${appendKoreanObjectParticle(formatKoreanIngredientBenefitContext(benefitPhrase))} 비교하는 고객이 참고할 수 있는 ${productType}입니다`,
      source: "positive-review-usefeel",
      score: 18 + reviewKeywords.length + benefits.length
    };
  }

  return {
    kind: "direct",
    question: `What comfort and finish signals do reviews repeat for ${directEntity}?`,
    keywords: selectReviewQueryCoreKeywords(product, locale, reviewKeywords, directEntity),
    answer: compactSentence([
      `Positive reviews for ${productName} repeat ${reviewPhrase}`,
      `Those comfort and finish signals help shoppers compare ${benefitPhrase} in ${englishProductTypeWithArticle(productType)}`
    ]),
    source: "positive-review-usefeel",
    score: 18 + reviewKeywords.length + benefits.length
  };
}

function createReviewDerivedQueryPropertyName(query: ReviewDerivedSearchQuery): string {
  return query.kind === "direct" ? "Direct product question" : "Indirect customer question";
}

function createReviewDerivedQueryPropertyID(query: ReviewDerivedSearchQuery): string {
  return query.kind === "direct" ? "directProductQuestion" : "indirectCustomerQuestion";
}

function createReviewDerivedQueryPropertyValue(query: ReviewDerivedSearchQuery): string {
  return compactSentence([query.question, query.answer]);
}

function selectReviewQueryCoreKeywords(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  reviewSignals: string[],
  context: string
): string[] {
  const productType = selectLocalizedSchemaProductType(product, locale);
  return dedupePublicListValues([
    ...reviewSignals,
    ...selectClaimedBenefitSignals(product, locale).slice(0, 3),
    ...selectReviewCepIngredientSignals(product, locale),
    productType,
    context
  ]
    .map(cleanSignal)
    .filter(isReviewDerivedQueryKeyword))
    .slice(0, 5);
}

function isReviewDerivedQueryKeyword(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || text.length > 64 || isNegativeReviewSignalText(text) || isQuestionLikeText(text) || isLowQualityPublicEvidenceText(text)) {
    return false;
  }
  if (/^(?:향|냄새|scent|fragrance|odor)$/iu.test(text)) {
    return false;
  }
  return true;
}

function selectLocalizedSchemaProductType(product: PdpProductSignal, locale: PdpGeoLocale): string {
  return localizeProductTypeForLocale(
    resolveProductType(product) ?? fallback(locale, {
      "ko-KR": "제품",
      "ja-JP": "商品",
      "en-US": "product",
      "en-GB": "product"
    }),
    locale
  );
}

function createDirectQueryEntityName(product: PdpProductSignal): string {
  const productName = createPublicProductEntityName(product);
  const brand = cleanSignal(product.brand ?? "");
  if (!brand || containsEntityToken(productName, brand) || isMachineReadableBrandIdentifier(brand)) {
    return productName;
  }
  return `${brand} ${productName}`.trim();
}

function isMachineReadableBrandIdentifier(value: string): boolean {
  const text = cleanSignal(value);
  return text === text.toLocaleLowerCase() && /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(text);
}

function createPublicProductEntityName(product: PdpProductSignal): string {
  return canonicalProductEntityName(product) ?? cleanSignal(product.name);
}

function createInferredSearchQueryDiagnostics(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  contentPlan?: PdpGeoContentPlan
): PdpGeoInferredSearchQueryDiagnostic[] {
  const modelPlannedQueries = createModelPlannedSearchQueries(product, locale, contentPlan);
  if (contentPlan?.mode === "model") {
    return uniqueReviewDerivedSearchQueries(modelPlannedQueries).map((query) => ({
      kind: query.kind,
      question: query.question,
      keywords: query.keywords,
      answer: query.answer,
      source: query.source,
      mentionsProductOrBrand: doesQuestionMentionProductOrBrand(query.question, product)
    }));
  }
  const fallbackQueries = createReviewDerivedSearchQueries(product, locale);
  return uniqueReviewDerivedSearchQueries([...modelPlannedQueries, ...fallbackQueries]).map((query) => ({
    kind: query.kind,
    question: query.question,
    keywords: query.keywords,
    answer: query.answer,
    source: query.source,
    mentionsProductOrBrand: doesQuestionMentionProductOrBrand(query.question, product)
  }));
}

/**
 * Converts accepted evidence-bound model FAQ/CEP decisions into the query
 * diagnostics consumed by downstream GEO evaluation. This is the primary
 * inference path when a model plan exists; fixed review patterns remain an
 * offline fallback only.
 */
function createModelPlannedSearchQueries(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  contentPlan?: PdpGeoContentPlan
): ReviewDerivedSearchQuery[] {
  if (contentPlan?.mode !== "model") {
    return [];
  }

  const plannedFaqQueries = contentPlan.faq
    .filter((item) => item.include && cleanSignal(item.question) && cleanSignal(item.answer))
    .map((item, index): ReviewDerivedSearchQuery => ({
      kind: doesQuestionMentionProductOrBrand(item.question, product) ? "direct" : "indirect",
      question: normalizeInferencePublicText(item.question, locale),
      keywords: selectModelPlannedQueryKeywords(product, locale, [item.cep, item.intent], contentPlan),
      answer: normalizeInferencePublicText(item.answer, locale),
      source: "model-inferred-cep",
      score: 120 - index
    }))
    .filter((query) => query.question && query.answer && query.keywords.length > 0);

  if (plannedFaqQueries.length > 0) {
    return plannedFaqQueries;
  }

  const descriptionAnswer = contentPlan.productDescription.include
    ? cleanSignal(contentPlan.productDescription.text)
    : contentPlan.webPageDescription.include
      ? cleanSignal(contentPlan.webPageDescription.text)
      : "";
  return contentPlan.cep.flatMap((cep, index): ReviewDerivedSearchQuery[] => {
    const situation = cleanSignal(cep.situation);
    const need = cleanSignal(cep.need);
    if (!situation || !need) {
      return [];
    }
    return [{
      kind: "indirect",
      question: createModelPlannedCepQuestion(product, locale, situation, need),
      keywords: selectModelPlannedQueryKeywords(product, locale, [situation, need, cep.constraint], contentPlan),
      answer: normalizeInferencePublicText(
        descriptionAnswer || createModelPlannedCepAnswer(product, locale, situation, need, cleanSignal(cep.constraint)),
        locale
      ),
      source: "model-inferred-cep",
      score: 100 - index
    }];
  });
}

function createModelPlannedCepAnswer(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  situation: string,
  need: string,
  constraint: string
): string {
  const productName = createPublicProductEntityName(product);
  const productType = selectLocalizedSchemaProductType(product, locale);
  if (locale === "ko-KR") {
    return compactSentence([
      createKoreanModelPlannedCepAnswerLead(productName, productType, situation, need),
      constraint ? ensureKoreanSentence(constraint) : undefined
    ]);
  }
  if (locale === "ja-JP") {
    return compactSentence([
      `${productName}は${situation}で${need}を検討する${productType}です`,
      constraint || undefined
    ]);
  }
  return compactSentence([
    `${productName} is ${englishProductTypeWithArticle(productType)} for ${situation}, with ${need} as the documented need`,
    constraint || undefined
  ]);
}

function createKoreanModelPlannedCepAnswerLead(productName: string, productType: string, situation: string, need: string): string {
  const situationText = trimTrailingSentencePunctuation(cleanSignal(situation));
  if (/(?:고객|사용자|대상)$/u.test(situationText)) {
    return `${appendKoreanTopicParticle(productName)} ${formatKoreanCepSituation(situationText)} 필요한 ${appendKoreanObjectParticle(need)} 다루는 ${productType}입니다`;
  }
  return `${appendKoreanTopicParticle(productName)} ${formatKoreanCepSituation(situationText)} ${appendKoreanObjectParticle(need)} 고려한 ${productType}입니다`;
}

function formatKoreanCepSituation(value: string): string {
  const situation = trimTrailingSentencePunctuation(cleanSignal(value));
  if (!situation) {
    return "해당 상황에서";
  }
  if (/때$/u.test(situation)) {
    return situation;
  }
  if (/(?:경우|상황|시점|단계)$/u.test(situation)) {
    return `${situation}에`;
  }
  if (/(?:고객|사용자|대상)$/u.test(situation)) {
    return `${situation}에게`;
  }
  return `${situation}에서`;
}

function selectModelPlannedQueryKeywords(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  seedValues: Array<string | undefined>,
  contentPlan: PdpGeoContentPlan
): string[] {
  const planTerms = contentPlan.cep.flatMap((cep) => [cep.situation, cep.need, cep.constraint]);
  return dedupePublicListValues([
    ...seedValues,
    ...planTerms,
    ...selectClaimedBenefitSignals(product, locale).slice(0, 2),
    ...selectLocalizedKeyIngredients(product, locale, 2)
  ]
    .map((value) => cleanSignal(value ?? ""))
    .filter(isReviewDerivedQueryKeyword))
    .slice(0, 7);
}

function createModelPlannedCepQuestion(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  situation: string,
  need: string
): string {
  const productType = selectLocalizedSchemaProductType(product, locale);
  return fallback(locale, {
    "ko-KR": `${formatKoreanCepSituation(situation)} ${appendKoreanSubjectParticle(trimTrailingSentencePunctuation(need))} 필요한 경우 어떤 ${appendKoreanSubjectParticle(productType)} 적합한가요?`,
    "ja-JP": `${trimTrailingSentencePunctuation(situation)}、${trimTrailingSentencePunctuation(need)}を求める場合はどの${productType}が適していますか？`,
    "en-US": `${capitalizeFirst(trimTrailingSentencePunctuation(situation))}, which ${lowercaseEnglishProductType(productType)} supports ${lowercaseFirst(trimTrailingSentencePunctuation(need))}?`,
    "en-GB": `${capitalizeFirst(trimTrailingSentencePunctuation(situation))}, which ${lowercaseEnglishProductType(productType)} supports ${lowercaseFirst(trimTrailingSentencePunctuation(need))}?`
  });
}

function doesQuestionMentionProductOrBrand(question: string, product: PdpProductSignal): boolean {
  return [product.name, product.originalName, product.brand]
    .filter((value): value is string => Boolean(cleanSignal(value ?? "")))
    .some((entity) => containsEntityToken(question, entity));
}

function uniqueReviewDerivedSearchQueries(queries: ReviewDerivedSearchQuery[]): ReviewDerivedSearchQuery[] {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = normalizeFaqQuestionKey(query.question);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectReviewCepIngredientSignals(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  const selected = selectLocalizedKeyIngredients(product, locale, 3);
  if (selected.length > 0) {
    return normalizeReviewCepIngredientSignals(selected, locale).slice(0, 3);
  }
  const sourceBackedIngredients = [
    ...(product.semanticFacts?.ingredients ?? []),
    ...product.ingredients
  ]
    .map(cleanSignal)
    .filter((value) => value.length <= 80 && !/[.。！？?]/u.test(value))
    .filter((value) => isUsefulKeyIngredientSignal(value, product) && !isIngredientAttributeOrOutcomeSignal(value));
  return normalizeReviewCepIngredientSignals(dedupePublicListValues(sourceBackedIngredients), locale)
    .slice(0, 3);
}

function normalizeReviewCepIngredientSignals(values: string[], locale: PdpGeoLocale): string[] {
  const deduped = dedupePublicListValues(values);
  if (locale !== "ko-KR") {
    return deduped;
  }
  const hasKoreanCeramide = deduped.some((value) => /세라마이드/u.test(value));
  return deduped.filter((value) => !(hasKoreanCeramide && /^Ceramide$/i.test(value)));
}

function formatKoreanReviewCepTarget(value: string | undefined): string | undefined {
  const rawTarget = cleanSignal(value ?? "")
    .replace(/\s*(?:에게|에)\s*$/u, "")
    .trim();
  const target = simplifyKoreanTargetCustomerForSentence(rawTarget) || rawTarget;
  if (!target || /^고객$/u.test(target)) {
    return undefined;
  }
  return /고객$/u.test(target) ? `${target}에게` : `${target} 고객에게`;
}

function sanitizeProductSchemaText(value: string, locale: PdpGeoLocale): string {
  return normalizeInferencePublicText(value, locale)
    .replace(/\\[rn]/g, " ")
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .replace(/\bAGREED\b/g, "agreed")
    .replace(/\bSelf-assessme…\b/gi, "self-assessment")
    .replace(/\b2Self-assessment\b/gi, "self-assessment")
    .replace(/\b(\d)\s*based\b/gi, "$1 based")
    .replace(/\s+([,.])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFormulaDetailText(value: string): string {
  return trimTrailingSentencePunctuation(normalizePublicFactText(value)
    .replace(/\s+and\s+(?=(?:[A-Z][\p{L}]+(?:’s|'s)?\s+proprietary)\b)/gu, ". ")
    .replace(/\.\s+and\s+/g, ". ")
    .replace(/\s+/g, " ")
    .trim());
}

function normalizePublicFactText(value: string): string {
  return cleanSignal(value)
    .replace(/^(?:(?:-{1,2}|=)>|→|⇒|➜|➔)\s*/u, "")
    .replace(/\bKEY INGREDIENTS\s*:\s*/g, "")
    .replace(/\bKEY INGREDIENTS\s+details?\s+mention\b/g, "Ingredient details mention")
    .replace(/\b(?:and|with)\s+KEY INGREDIENTS\b/g, "")
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\btargetd\b/gi, "targeted")
    .replace(/\\[rn]/g, " ")
    .replace(/:([^\s])/g, ": $1")
    .replace(/([.!?。！？])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Applies target-locale surface conventions before a candidate becomes public
 * copy. This is intentionally product-agnostic: it resolves script/spacing
 * variants while preserving the inferred fact and field role.
 */
function normalizeInferencePublicText(value: string, locale: PdpGeoLocale): string {
  return value
    .split("\n")
    .map((line) => {
      let text = normalizePublicFactText(line);
      if (locale === "ko-KR") {
        text = text
          .replace(/민감피부/g, "민감 피부")
          .replace(/건조피부/g, "건조 피부")
          .replace(/피부장벽/g, "피부 장벽")
          .replace(/(들어가|함유되어|포함되어|배합되어|담겨|기재되어|표기되어)\s*(있는|없는)/gu, "$1 $2")
          .replace(/(?:으)?로\s*설명된다[.!。]?$/u, "입니다.")
          .replace(/\s+([,.)\]}>])/g, "$1")
          .replace(/([([{<])\s+/g, "$1");
        text = normalizeKoreanSurfaceParticles(text);
      }
      return text;
    })
    .join("\n")
    .trim();
}

function enforceDescriptionEntityMentionBudget(
  value: string,
  productName: string,
  locale: PdpGeoLocale,
  budget: number
): string {
  const tokens = cleanSignal(productName).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0 || budget < 1) {
    return value;
  }
  const pattern = new RegExp(tokens.map(escapeRegExp).join("\\s+"), "giu");
  let mentions = 0;
  const replacement = locale === "ko-KR"
    ? "이 제품"
    : locale === "ja-JP"
      ? "本品"
      : "the product";
  return value.replace(pattern, (match) => {
    mentions += 1;
    return mentions <= budget ? match : replacement;
  });
}

function normalizeKoreanSurfaceParticles(value: string): string {
  return value.replace(/([가-힣]{1,40})(을|를|은|는|이|가|와|과)(?=[\s,.!?。！？]|$)/gu, (match, stem: string, particle: string) => {
    if (/(?:효과|결과|성과|피부과|소아과|치과|안과|외과|내과|학과|사과)$/u.test(match)) {
      return match;
    }
    if (stem.length <= 1 && /[은는이가]/u.test(particle)) {
      return match;
    }
    if (/(?:있|없|하|되|같|싶)$/u.test(stem) && /[은는]/u.test(particle)) {
      return match;
    }
    if (!isKoreanDomainNounForParticleRepair(stem)) {
      return match;
    }
    if (particle === "은" || particle === "는") return `${stem}${hasKoreanBatchim(stem) ? "은" : "는"}`;
    if (particle === "이" || particle === "가") return `${stem}${hasKoreanBatchim(stem) ? "이" : "가"}`;
    if (particle === "을" || particle === "를") return `${stem}${hasKoreanBatchim(stem) ? "을" : "를"}`;
    return `${stem}${hasKoreanBatchim(stem) ? "과" : "와"}`;
  });
}

function isKoreanDomainNounForParticleRepair(value: string): boolean {
  return /(?:수분감|사용감|보습력|흡수력|유지력|피부결|피부\s*장벽|장벽|수분|보습|효능|효과|성분|기술|제품|상품|크림|세럼|토너|로션|앰플|에센스|클렌저|고객|피부|루틴|단계|결과|내용|특징|기준|관리|탄력|진정|주름|광채|윤기|길이|사계절)$/u.test(value);
}

function addSentencePunctuationSpacing(_match: string, punctuation: string, offset: number, input: string): string {
  if (punctuation === "." && /\d/.test(input[offset - 1] ?? "") && /\d/.test(input[offset + 1] ?? "")) {
    return punctuation;
  }
  return `${punctuation} `;
}

function isUsefulSchemaPropertyValue(name: string, value: string): boolean {
  if (!value || isNonCitationEvidenceArtifact(value) || hasTruncationMarker(value) || isQuestionLikeText(value) || isBrokenMarketingFragment(value) || isLowQualityPublicEvidenceText(value)) {
    return false;
  }
  if (/^(?:Functional certification|Brand science|Customer review context|Ingredient\/effect detail|Reported details|Clinical result summary)$/i.test(name)
    && /(?:NEW\s*[,.]|확인\s*키워드|성분\s*설명입니다|상품\s*상세\s*테스트|결과\s*성분\s*설명|\\[rn])/i.test(value)) {
    return false;
  }
  if (/^Functional certification$/i.test(name) && (isQuantifiedClinicalResultSentence(value) || value.length > 160)) {
    return false;
  }
  if (/^Brand science$/i.test(name) && value.length > 180) {
    return false;
  }
  if (/^Customer review context$/i.test(name) && value.length > 240) {
    return false;
  }
  if (/^Clinical result summary$/i.test(name)) {
    return hasCompleteReportedDetailContext(value);
  }
  if (/^Reported details$/i.test(name)) {
    return !isQuestionLikeText(value)
      && !isNonCitationEvidenceArtifact(value)
      && hasMinimumReportedEvidenceContext(value)
      && !isCommerceMetricArtifact(value);
  }
  if (name === "Key ingredients") {
    return value.split(",").every((item) => {
      const token = cleanSignal(item);
      return token.length > 0
        && token.length <= 80
        && !/[.。！？?]/.test(token)
        && !/(설계|동일|자극|고객님|리뉴얼 전 제품)/.test(token)
        && !isIngredientAttributeOrOutcomeSignal(token);
    });
  }
  return true;
}

function hasCompleteReportedDetailContext(value: string): boolean {
  const text = cleanSignal(value);
  if (!isQuantifiedClinicalResultSentence(text)) {
    return false;
  }
  const hasPopulation = hasReportedSampleScope(text);
  const hasPeriod = /(?:\d+(?:\.\d+)?\s*(?:주|일|시간|weeks?|days?|hours?)|시험\s*기간|after\s+\d|사용\s*중단\s*1\s*주\s*후|daily\s+use)/i.test(text);
  const hasMethod = /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)/i.test(text);
  return hasPopulation && hasPeriod && hasMethod;
}

function createPositiveNotes(product: PdpProductSignal, locale: PdpGeoLocale): JsonObject | undefined {
  const notes = dedupePublicListValues([
    ...selectPublicBenefitSignals(product, locale),
    ...selectGroundedExpressionPhrases(product, locale, 6)
  ].filter((value): value is string => Boolean(value)).filter(isUsefulPositiveNoteValue)).slice(0, 6);
  if (notes.length === 0) {
    return undefined;
  }

  return {
    "@type": "ItemList",
    itemListElement: notes.map((name, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name
    }))
  };
}

export function createPdpGeoContentHtml(sections: PdpGeoContentSections, locale: PdpGeoLocale): string {
  const labels = sectionLabels(locale);
  const entries: Array<[keyof PdpGeoContentSections, string]> = [
    ["productName", sections.productName],
    ["description", sections.description],
    ["quickFacts", sections.quickFacts],
    ["benefits", sections.benefits],
    ["ingredients", sections.ingredients],
    ["howToUse", sections.howToUse],
    ["faq", sections.faq]
  ];

  const visibleEntries = entries.filter(([key, value]) => (key !== "howToUse" && key !== "faq") || value.trim().length > 0);
  const items = visibleEntries.map(([key, value], index) => `
    <div class="geo-content-accordion__item">
      <button class="geo-content-accordion__trigger" type="button" aria-expanded="${index === 0 ? "true" : "false"}">
        ${escapeHtml(labels[key])}
      </button>
      <div class="geo-content-accordion__panel">
        ${formatSectionHtmlForAccordion(value)}
      </div>
    </div>`).join("\n");

  return `<div class="geo-content-accordion" data-locale="${escapeHtml(locale)}">${items}\n</div>`;
}

function formatSectionHtmlForAccordion(value: string): string {
  if (value.includes("\n")) {
    const lines = value.split("\n").filter(Boolean);
    return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-\d.]+\s*/, ""))}</li>`).join("")}</ul>`;
  }
  return `<p>${escapeHtml(value)}</p>`;
}

function sectionLabels(locale: PdpGeoLocale): Record<keyof PdpGeoContentSections, string> {
  if (locale === "ko-KR") {
    return {
      productName: "상품명",
      description: "GEO 설명",
      quickFacts: "핵심 정보",
      benefits: "효능/효과",
      ingredients: "성분",
      howToUse: "사용법",
      faq: "FAQ"
    };
  }
  if (locale === "ja-JP") {
    return {
      productName: "商品名",
      description: "GEO説明",
      quickFacts: "主な情報",
      benefits: "ベネフィット",
      ingredients: "成分",
      howToUse: "使い方",
      faq: "FAQ"
    };
  }
  return {
    productName: "Product name",
    description: "GEO description",
    quickFacts: "Quick facts",
    benefits: "Benefits",
    ingredients: "Ingredients",
    howToUse: "How to use",
    faq: "FAQ"
  };
}

function createRecommendations(
  product: PdpProductSignal,
  sections: PdpGeoContentSections,
  concepts: TerminologyConcept[],
  locale: PdpGeoLocale,
  guidance: GeoOptimizationGuidance
): PdpGeoRecommendation[] {
  const recommendations: PdpGeoRecommendation[] = [];

  if (sections.productName !== product.name) {
    recommendations.push({
      field: "productName",
      message: sections.productName,
      reason: "Added one concise locale-aware category or benefit phrase to make the product entity easier to identify without keyword stuffing."
    });
  }
  recommendations.push({
    field: "description",
    message: sections.description,
    reason: "Structured the description for generative engines: target customer, product identity, ingredient/technology, benefit or citation-ready metric, then usage/comparison/review context."
  });
  if (concepts.length > 0) {
    recommendations.push({
      field: "terminology",
      message: concepts.map((concept) => `${concept.concept}: ${preferredTerms(concept, locale).join(", ")}`).join(" / "),
      reason: "Applied locale terminology mapping so the same product can use market-natural wording."
    });
  }
  if (product.reviews.keywords.length > 0) {
    recommendations.push({
      field: "benefits",
      message: product.reviews.keywords.slice(0, 5).join(", "),
      reason: "Review-backed positive keywords were included as search-ready product signals."
    });
  }
  if (guidance.sources.length > 0) {
    recommendations.push({
      field: "howToUse",
      message: sections.howToUse,
      reason: `Reconstructed usage instructions into answer-ready steps using selected GEO RAG guidance: ${guidance.sources.join(", ")}.`
    });
    recommendations.push({
	      field: "faq",
	      message: sections.faq,
	      reason: "Reframed FAQ around GEO question intent, product benefit, ingredient/technology, usage context, suitability, and evidence signals so generated answers stay grounded and reusable."
	    });
  }

  return recommendations;
}

function selectedOfficialDocSources(chunks: PdpGeoRetrievedChunk[]): string[] {
  return Array.from(new Set(
    chunks
      .filter((chunk) => chunk.kind === "official-docs" || /official|openai|google|gemini|perplexity/i.test(`${chunk.source} ${chunk.title ?? ""}`))
      .map((chunk) => chunk.source)
  )).slice(0, 4);
}

function createGeoOptimizationGuidance(
  chunks: PdpGeoRetrievedChunk[],
  reasoning: PdpGeoReasoningResult
): GeoOptimizationGuidance {
  const sources = unique([
    ...reasoning.selectedSources,
    ...chunks.map(formatRagSource)
  ]).slice(0, 8);
  const principles = reasoning.principles;

  return {
    sources,
    reasoning,
    principles,
    useAnswerReadyFaq: isPdpGeoReasoningEnabled(reasoning, "answer-ready FAQ"),
    useStepwiseUsage: isPdpGeoReasoningEnabled(reasoning, "stepwise HowTo"),
    useEvidenceBackedClaims: isPdpGeoReasoningEnabled(reasoning, "evidence-backed claims"),
    useTargetCustomerContext: isPdpGeoReasoningEnabled(reasoning, "target customer context"),
    useReviewIntentFaq: isPdpGeoReasoningEnabled(reasoning, "review-intent FAQ")
  };
}

function formatRagSource(chunk: Pick<PdpGeoRetrievedChunk, "source" | "title">): string {
  return chunk.title ? `${chunk.source}#${chunk.title}` : chunk.source;
}

function readTerminologyConcepts(documents: Array<{ name: string; content: string }>): TerminologyConcept[] {
  const brandTerminologyMaps = new Set<string>(Object.values(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps));
  const document = documents.find((item) => brandTerminologyMaps.has(normalizeRagDocumentName(item.name)))
    ?? documents.find((item) => normalizeRagDocumentName(item.name) === pdpGeoGeneratorRagManifest.documents.localeTerminologyMap)
    ?? documents.find((item) => /terminology/i.test(item.name));
  if (!document) {
    return [];
  }

  try {
    const parsed = JSON.parse(document.content) as { concepts?: TerminologyConcept[] };
    return Array.isArray(parsed.concepts) ? parsed.concepts : [];
  } catch {
    return [];
  }
}

function normalizeRagDocumentName(name: string): string {
  return name.replace(/\\/g, "/");
}

function detectTerminologyConcepts(product: PdpProductSignal, concepts: TerminologyConcept[]): TerminologyConcept[] {
  const haystack = [
    product.name,
    product.description,
    ...product.benefits,
    ...product.effects,
    ...product.ingredients,
    ...product.usage,
    ...product.reviews.keywords,
    ...product.sourceTexts.slice(0, 20)
  ].filter(Boolean).join(" ").toLowerCase();

  return concepts.filter((concept) => {
    const terms = unique([
      concept.concept,
      ...Object.values(concept.preferred ?? {}).flat(),
      ...Object.values(concept.avoid ?? {}).flat()
    ]).map((term) => term.toLowerCase());
    return terms.some((term) => haystack.includes(term.toLowerCase()));
  });
}

function preferredTerms(concept: TerminologyConcept, locale: PdpGeoLocale): string[] {
  return concept.preferred?.[locale] ?? concept.preferred?.["en-US"] ?? [];
}

function applyAvoidTerms(value: string, concepts: TerminologyConcept[], locale: PdpGeoLocale, diagnostics: PdpGeoTerminologyDiagnostics): string {
  let next = value;

  for (const concept of concepts) {
    const replacement = preferredTerms(concept, locale)[0];
    for (const avoid of concept.avoid?.[locale] ?? []) {
      if (next.includes(avoid)) {
        next = next.split(avoid).join(replacement ?? "");
        diagnostics.avoidedTerms.push({
          concept: concept.concept,
          term: avoid,
          replacement
        });
      }
    }
  }

  return next;
}

function createTerminologyDiagnostics(locale: PdpGeoLocale, market?: string): PdpGeoTerminologyDiagnostics {
  return {
    locale,
    market,
    appliedTerms: [],
    avoidedTerms: [],
    suggestions: []
  };
}

function quickFactSentence(locale: PdpGeoLocale, label: string, value?: string): string | undefined {
  const cleanValue = cleanSignal(value ?? "");
  if (!cleanValue) {
    return undefined;
  }
  const text = trimTrailingSentencePunctuation(cleanValue);

  if (locale === "ko-KR") {
    if (label === "Target") {
      return `대상 고객은 ${text}입니다.`;
    }
    if (label === "Key benefit") {
      return `${appendKoreanObjectParticle(formatKoreanListForSentence(text))} 중심으로 효능 정보를 확인할 수 있습니다.`;
    }
    if (label === "Recommended skin type") {
      return `추천 피부 타입은 ${text}입니다.`;
    }
    if (label === "Key ingredients") {
      return `주요 성분은 ${text}입니다.`;
    }
    if (label === "Search context") {
      return `비교할 때 ${text} 같은 표현을 함께 확인할 수 있습니다.`;
    }
    if (label === "Customer reviews") {
      return `고객 리뷰에서는 ${text} 같은 표현이 확인됩니다.`;
    }
    return ensurePublicSentence(text, locale);
  }

  if (locale === "ja-JP") {
    if (label === "Target") {
      return `対象は${text}です。`;
    }
    if (label === "Key benefit") {
      return `主なベネフィットは${text}です。`;
    }
    if (label === "Recommended skin type") {
      return `おすすめの肌タイプは${text}です。`;
    }
    if (label === "Key ingredients") {
      return `主な成分は${text}です。`;
    }
    if (label === "Search context") {
      return `比較時には${text}などの表現を確認できます。`;
    }
    if (label === "Customer reviews") {
      return `レビューでは${text}などの表現が見られます。`;
    }
    return ensurePublicSentence(text, locale);
  }

  if (label === "Target") {
    return `This product is positioned for ${text}.`;
  }
  if (label === "Key benefit") {
    return `The main care focus is ${text}.`;
  }
  if (label === "Recommended skin type") {
    return `Recommended skin type: ${text}.`;
  }
  if (label === "Key ingredients") {
    return `Key ingredients include ${text}.`;
  }
  if (label === "Search context") {
    return `Comparison cues include ${text}.`;
  }
  if (label === "Customer reviews") {
    return `Customer reviews mention ${text}.`;
  }
  if (label === "Reported details") {
    if (isStructuredMetricSummary(text)) {
      return ensurePublicSentence(text, locale);
    }
    return /^In an?\b/i.test(text)
      ? `Consumer assessment: ${text}.`
      : `The product is described with ${text}.`;
  }
  return ensurePublicSentence(text, locale);
}

function ensurePublicSentence(value: string, locale: PdpGeoLocale): string {
  const text = value.trim();
  if (/[.!?。！？]$/.test(text)) {
    return text;
  }
  return `${text}${locale === "ja-JP" ? "。" : "."}`;
}

function formatEnglishFactComplement(value: string): string {
  const text = trimTrailingSentencePunctuation(value).trim();
  const ingredientRole = text.match(/^([A-Z][\p{L}\p{N}\s()™®'’.-]{1,90})\s+-\s+((?:helps?|supports?|improves?|enhances?|delivers?|provides?|soothes?|hydrates?|cleanses?|targets?)\b.+)$/iu);
  if (ingredientRole?.[1] && ingredientRole[2]) {
    const subject = ingredientRole[1].trim();
    const predicate = ingredientRole[2].trim();
    return `${subject} ${lowercaseSentenceStart(predicate)}`;
  }
  if (/^(?:A|An|The)\s+[a-z]/.test(text)) {
    return lowercaseSentenceStart(text);
  }
  return text;
}

function formatEnglishUsagePagePhrase(value: string): string {
  const text = trimTrailingSentencePunctuation(value).trim();
  const withoutUse = text.replace(/^use(?:\s+it)?\s+/i, "").trim();
  if (withoutUse !== text) {
    return lowercaseSentenceStart(withoutUse);
  }
  const withoutApply = text.replace(/^apply\s+/i, "").trim();
  if (withoutApply !== text) {
    return `applying ${lowercaseSentenceStart(withoutApply)}`;
  }
  return lowercaseSentenceStart(text);
}

function createEnglishUsageActionSentence(value: string): string {
  const text = trimTrailingSentencePunctuation(value).trim();
  const withoutUse = text.replace(/^use(?:\s+it)?\s+/i, "").trim();
  if (withoutUse !== text) {
    return `Use it ${lowercaseSentenceStart(withoutUse)}`;
  }
  return capitalizeFirst(text);
}

function createEnglishProductUsageSentence(productName: string, value: string): string {
  const text = trimTrailingSentencePunctuation(value).trim();
  const withoutUse = text.replace(/^use(?:\s+it)?\s+/i, "").trim();
  if (withoutUse !== text) {
    return `${productName} can be used ${lowercaseSentenceStart(withoutUse)}`;
  }
  return `${productName} can be used as follows: ${capitalizeFirst(text)}`;
}

function englishSubjectVerb(subject: string, singular: string, plural: string): string {
  return /\b(?:and|,)\b/i.test(subject) ? plural : singular;
}

function lowercaseSentenceStart(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function indefiniteArticle(value: string): "a" | "an" {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a";
}

function fallback(locale: PdpGeoLocale, values: Record<PdpGeoLocale, string>): string {
  return values[locale] ?? values["en-US"];
}

function compactSentence(parts: Array<string | undefined>): string {
  const cleanedParts = (parts.filter(Boolean) as string[]).map((part) => part.trim().replace(/[,，]+$/, ""));
  const text = trimTrailingSentencePunctuation(
    cleanedParts
      .join(". ")
      .replace(/([?？!！])\s*\./g, "$1")
      .replace(/\.+/g, ".")
      .trim()
  );
  return `${text}${/[ぁ-ゟ゠-ヿ]/u.test(text) ? "。" : "."}`;
}

function cleanJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanJson(item))
      .filter((item) => item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, cleanJson(item)] as const)
      .filter(([, item]) => item !== undefined && item !== null && item !== "" && !(Array.isArray(item) && item.length === 0));
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

function truncate(value: string, _limit: number): string {
  return value;
}

function truncateAtCompleteSentence(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const head = value.slice(0, limit);
  const sentenceBoundary = Math.max(head.lastIndexOf("."), head.lastIndexOf("。"), head.lastIndexOf("!"), head.lastIndexOf("?"));
  if (sentenceBoundary > limit * 0.5) {
    return head.slice(0, sentenceBoundary + 1).trim();
  }

  const commaBoundary = Math.max(head.lastIndexOf(", and "), head.lastIndexOf(";"));
  if (commaBoundary > limit * 0.5) {
    return head.slice(0, commaBoundary).trim();
  }

  return value;
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.。]+$/g, "").trim();
}

function createKoreanEvidenceContentSentence(evidence: string): string {
  const cleanEvidence = trimTrailingSentencePunctuation(evidence).trim();
  const rewrittenClaim = rewriteKoreanMetaClaimSentence(cleanEvidence);
  if (rewrittenClaim) {
    return rewrittenClaim;
  }
  return cleanEvidence;
}

function createKoreanEvidenceFactSentence(evidence: string): string {
  const cleanEvidence = trimTrailingSentencePunctuation(evidence).trim();
  if (hasQuantifiedReportedSignal(cleanEvidence)) {
    const naturalEvidence = createKoreanEvidenceResultSentence(cleanEvidence);
    if (naturalEvidence && !/측정\/평가\s*결과를\s*포함합니다/u.test(naturalEvidence)) {
      return naturalEvidence;
    }
  }
  if (isKoreanCompleteSentence(cleanEvidence)) {
    return cleanEvidence;
  }
  const metrics = cleanEvidence
    .replace(/(?:확인\s*지표|확인\s*근거|측정\s*결과|평가\s*지표)\s*:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*결과$/u, "");
  return createKoreanEvidenceResultSentence(metrics);
}

function rewriteKoreanMetaClaimSentence(value: string): string | undefined {
  const metaClaim = value.match(/^(.+?)\s*성분\/기술은\s*(.+?)\s*효능 맥락과 연결되어\s*(.+?)\s*비교에 필요한 핵심 케어 근거(?:를)?\s*설명합니다$/);
  if (metaClaim) {
    const ingredientPhrase = metaClaim[1]?.trim();
    const outcomePhrase = metaClaim[2]?.trim();
    const productType = metaClaim[3]?.trim();
    if (ingredientPhrase && outcomePhrase && productType) {
      return createKoreanGeoClaimSentence(ingredientPhrase, outcomePhrase, productType);
    }
  }
  return undefined;
}

function isKoreanCompleteSentence(value: string): boolean {
  return /(?:습니다|합니다|됩니다|입니다|니다|어요|예요|돼요|세요|주세요|십시오)$/u.test(value.trim());
}


function formatUsageForProductDescription(usage: string | undefined, locale: PdpGeoLocale): string | undefined {
  const fragments = splitCompleteUsageFragments(usage).map((fragment) => normalizeUsageForDescription(fragment, locale));
  const primary = first(fragments);
  if (!primary) {
    return undefined;
  }

  const secondary = fragments.find((fragment) => fragment !== primary && /warm|apply|massage|pat|wrap|palm|덜어|바르|흡수|감싸|なじませ|塗布|手/i.test(fragment));

  if (locale === "en-US" || locale === "en-GB") {
    return secondary ? `${normalizeEnglishUsageLead(primary)}, then ${lowercaseFirst(normalizeEnglishUsageFollowup(secondary))}` : normalizeEnglishUsageLead(primary);
  }

  if (locale === "ko-KR") {
    return secondary ? `${primary}, 이후 ${secondary}` : primary;
  }

  return secondary ? `${primary}、その後${secondary}` : primary;
}

function splitCompleteUsageFragments(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return cleanSignal(value)
    .split(/(?<=[.!?。])\s+|[;；]/)
    .map(trimTrailingSentencePunctuation)
    .filter((fragment) => fragment.length >= 8 && fragment.length <= 220)
    .slice(0, 4);
}

function normalizeUsageForDescription(value: string, locale: PdpGeoLocale): string {
  const normalized = trimTrailingSentencePunctuation(value)
    .replace(/\byour\b/gi, "the")
    .replace(/\bafter applying toner\b/gi, "after toner")
    .replace(/\s*,\s*after toner\b/gi, " after toner")
    .replace(/\s+/g, " ")
    .trim();

  if (locale === "en-US" || locale === "en-GB") {
    return normalized;
  }

  return normalized;
}

function normalizeEnglishUsageLead(value: string): string {
  return value
    .replace(/^use\s+it\b/i, "Use it")
    .replace(/^use\s+/i, "Use it ")
    .replace(/^apply\s+it\b/i, "Apply it")
    .replace(/^apply\s+/i, "Apply it ")
    .trim();
}

function normalizeEnglishUsageFollowup(value: string): string {
  return value
    .replace(/^then\s+/i, "")
    .replace(/^use\s+it\b/i, "use it")
    .replace(/^use\s+/i, "use it ")
    .replace(/^apply\s+it\b/i, "apply it")
    .replace(/^apply\s+/i, "apply it ")
    .trim();
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}

function capitalizeFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function hasTruncationMarker(value: string): boolean {
  return /…|⋯|\.{3,}/.test(value);
}

function formatKoreanListForSentence(value: string): string {
  const items = value.split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length <= 1) {
    return value.trim();
  }
  if (items.length > 2 || items.some((item) => /[A-Za-z]/.test(item))) {
    return items.join(", ");
  }
  const head = items.slice(0, -1).join(", ");
  const tail = items.at(-1) ?? "";
  return `${head}${hasKoreanBatchim(head) ? "과" : "와"} ${tail}`;
}

function formatKoreanFaqBenefitPhrase(product: PdpProductSignal, locale: PdpGeoLocale, fallbackBenefit: string): string {
  const sourceCandidates = selectClaimedBenefitSignals(product, locale).slice(0, 3);
  const candidates = sourceCandidates.length ? sourceCandidates : selectPublicBenefitSignals(product, locale).slice(0, 3);
  return formatKoreanCarePhraseForFaq(formatKoreanNaturalList(candidates) ?? fallbackBenefit);
}

function formatKoreanCarePhraseForFaq(value: string): string {
  return cleanSignal(value)
    .replace(/\s*효능\s*\/\s*케어/g, " 효능/케어")
    .replace(/\s+케어\s+케어/g, " 케어")
    .replace(/피부\s*장벽/g, "피부 장벽")
    .trim();
}

function formatKoreanFaqTargetClause(product: PdpProductSignal): string | undefined {
  const target = cleanSignal(createTargetCustomerProperty(product, "ko-KR") ?? "");
  if (!target) {
    return undefined;
  }

  const normalized = simplifyKoreanTargetCustomerForSentence(target) || target
    .replace(/\s*또는\s*/g, "와 ")
    .replace(/\s*및\s*/g, "와 ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!normalized) {
    return undefined;
  }
  if (/(?:피부|스킨)\s*고객$/.test(normalized)) {
    return `${normalized.replace(/\s*고객$/u, "")}에 적합하며,`;
  }
  if (/(?:고객|사용자|분)$/.test(normalized)) {
    return `${normalized}에게 적합하며,`;
  }
  return `${normalized}에 적합하며,`;
}

function formatKoreanFaqProductType(product: PdpProductSignal): string {
  const rawProductType = resolveProductType(product) ?? "제품";
  const productType = localizeProductTypeForLocale(rawProductType, "ko-KR");
  if (!productType || productType.length > 30 || /[.!?。！？]/.test(productType)) {
    return "제품";
  }
  return productType;
}

function createKoreanIngredientFaqSupportSentence(ingredient: string, benefitPhrase: string): string {
  return `${formatKoreanIngredientTopicPhrase(ingredient)} ${appendKoreanObjectParticle(benefitPhrase)} 뒷받침합니다`;
}

function formatKoreanIngredientIncludedSubject(value: string): string {
  const text = formatKoreanListForSentence(value);
  return shouldUseKoreanIngredientTechnologySuffix(text)
    ? `${text} 성분/기술이`
    : appendKoreanSubjectParticle(text);
}

function formatKoreanIngredientTopicPhrase(value: string): string {
  const text = formatKoreanListForSentence(value);
  if ((text.includes(",") || /[A-Za-z]/.test(text)) && shouldUseKoreanIngredientTechnologySuffix(text)) {
    return `${text} 성분/기술은`;
  }
  return appendKoreanTopicParticle(text);
}

function formatKoreanIngredientObjectPhrase(value: string): string {
  const text = formatKoreanListForSentence(value);
  if ((text.includes(",") || /[A-Za-z]/.test(text)) && shouldUseKoreanIngredientTechnologySuffix(text)) {
    return `${text} 성분/기술을`;
  }
  return appendKoreanObjectParticle(text);
}

function shouldUseKoreanIngredientTechnologySuffix(value: string): boolean {
  return !/(?:성분|기술|포뮬러|캡슐|복합체|워터)$/u.test(value.trim());
}

function appendKoreanTopicParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "은" : "는"}`;
}

function appendKoreanObjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "을" : "를"}`;
}

function appendKoreanSubjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "이" : "가"}`;
}

function appendKoreanConjunctionParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "과" : "와"}`;
}

function appendKoreanInstrumentParticle(value: string): string {
  const last = [...value.trim()].at(-1);
  if (!last) {
    return value;
  }
  const code = last.charCodeAt(0);
  const jongseong = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : 0;
  return `${value}${jongseong === 0 || jongseong === 8 ? "로" : "으로"}`;
}

function appendKoreanObjectParticleSuffix(value: string): string {
  return hasKoreanBatchim(value) ? "을" : "를";
}

function hasKoreanBatchim(value: string): boolean {
  const last = [...value.trim()].at(-1);
  if (!last) {
    return false;
  }
  const code = last.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}

function first(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
