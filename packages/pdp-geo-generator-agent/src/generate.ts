import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import { createPdpGeoReasoning, isPdpGeoReasoningEnabled } from "./rag/reasoning";
import { isConflictingProductUsageInstruction } from "./product-scope";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoContentSections,
  PdpGeoEvidence,
  PdpGeoFaqItem,
  PdpGeoGenerationHints,
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
}

interface GenerateArtifactsOutput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  recommendations: PdpGeoRecommendation[];
  evidence: PdpGeoEvidence[];
  terminology: PdpGeoTerminologyDiagnostics;
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

const defaultTargets: PdpGeoSchemaTarget[] = ["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList"];

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
  const faq = ensureFaq(input.product, input.locale, productName, guidance, optimizedUsageSteps);
  const sections: PdpGeoContentSections = {
    productName,
    description: applyAvoidTerms(createGeoDescription(input.product, productName, input.locale, localizedTerms, guidance, optimizedUsageSteps), terminologyConcepts, input.locale, terminology),
    quickFacts: applyAvoidTerms(createQuickFacts(input.product, input.locale, localizedTerms, guidance), terminologyConcepts, input.locale, terminology),
    benefits: applyAvoidTerms(createBenefitsSection(input.product, input.locale, guidance), terminologyConcepts, input.locale, terminology),
    ingredients: applyAvoidTerms(createIngredientsSection(input.product, input.locale), terminologyConcepts, input.locale, terminology),
    howToUse: applyAvoidTerms(createHowToUseSection(input.product, input.locale, optimizedUsageSteps), terminologyConcepts, input.locale, terminology),
    faq: applyAvoidTerms(createFaqSection(faq, input.locale), terminologyConcepts, input.locale, terminology)
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
    { field: "content.description", source: "rag", value: `Description follows target customer + benefits + ingredients/technology + usage context + review keywords + evidence. ${input.ragChunks.length} RAG chunks selected.` }
  );
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
    productDescription: sections.description,
    webPageDescription: applyAvoidTerms(
      createWebPageDescription(input.product, productName, input.locale, localizedTerms, optimizedUsageSteps),
      terminologyConcepts,
      input.locale,
      terminology
    ),
    faq,
    optimizedUsageSteps,
    locale: input.locale,
    market: input.market,
    sourceUrl: input.sourceUrl,
    targets: input.hints?.schemaTargets ?? defaultTargets
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
    terminology
  };
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
      return compactSentence([
        createKoreanProductLeadDescription(productName, context, benefit),
        createKoreanProductIngredientDescription(context),
        createProductUsageDescription(locale, context.usage),
        createLocalizedReviewDescription(locale, context)
      ]);
    case "ja-JP":
      return compactSentence([
        `${productName}は${context.targetCustomer}向けの${context.productType}として、${benefit}を中心に説明します`,
        createProductIngredientDescription(locale, context),
        createProductUsageDescription(locale, context.usage),
        createLocalizedReviewDescription(locale, context),
        evidence ? createProductEvidenceDescription(locale, evidence) : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        `${productName} is ${englishProductTypeWithArticle(context.productType)} for ${context.targetCustomer}, with benefits such as ${benefit}`,
        createProductIngredientDescription(locale, context),
        createProductUsageDescription(locale, context.usage),
        createLocalizedReviewDescription(locale, context),
        evidence ? createProductEvidenceDescription(locale, evidence) : undefined
      ]);
  }
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
      return compactSentence([
        createKoreanWebPageCoverageLead(product, productName, context),
        createKoreanWebPageCoverageScopeDescription(product, context),
        createKoreanWebPageDecisionDescription(context),
        createKoreanWebPageAnswerCoverageDescription(product, context),
        context.usage ? createWebPageUsageDescription(locale, context.usage) : undefined,
        context.reportedDetail ? createWebPageEvidenceDescription(locale, context.reportedDetail) : undefined
      ]);
    case "ja-JP":
      return compactSentence([
        createJapaneseWebPageCoverageLead(product, productName, context),
        createJapaneseWebPageCoverageScopeDescription(product, context),
        createJapaneseWebPageDecisionDescription(context),
        createJapaneseWebPageAnswerCoverageDescription(product, context),
        context.usage ? createWebPageUsageDescription(locale, context.usage) : undefined,
        context.reportedDetail ? createWebPageEvidenceDescription(locale, context.reportedDetail) : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        createEnglishWebPageCoverageLead(product, productName, context),
        createEnglishWebPageCoverageScopeDescription(product, context),
        context.benefitPhrase ? `Decision details on the page include ${context.benefitPhrase}` : undefined,
        context.ingredientPhrase ? `It connects those decision details with key ingredients and technologies including ${context.ingredientPhrase}${context.ingredientDetail ? `, with formula details such as ${context.ingredientDetail}` : ""}` : undefined,
        createEnglishWebPageAnswerCoverageDescription(product, context),
        !context.ingredientPhrase && context.pageFactPhrase ? createEnglishWebPageFactDescription(context.pageFactPhrase) : undefined,
        context.usage ? createWebPageUsageDescription(locale, context.usage) : undefined,
        context.reviewPhrase ? `It also reflects customer review language such as ${context.reviewPhrase}` : undefined,
        context.reportedDetail ? createWebPageEvidenceDescription(locale, context.reportedDetail) : undefined
      ]);
  }
}

function createKoreanWebPageCoverageLead(product: PdpProductSignal, productName: string, context: DescriptionContext): string {
  const primaryFacts = formatDescriptionList(selectWebPagePrimaryProductFacts(product, context, "ko-KR"), "ko-KR", 3);
  const productTypeObject = appendKoreanObjectParticle(context.productType);
  return primaryFacts
    ? `${productName} 상품 페이지는 ${context.targetCustomer}이 ${productTypeObject} 비교할 때 ${primaryFacts} 같은 상품 정보를 먼저 확인할 수 있도록 소개하는 페이지입니다`
    : `${productName} 상품 페이지는 ${context.targetCustomer}이 ${productTypeObject} 비교할 때 필요한 상품 정보를 먼저 확인할 수 있도록 소개하는 페이지입니다`;
}

function createKoreanWebPageCoverageScopeDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const coverage = formatDescriptionList(selectWebPageCoverageTopics(product, context, "ko-KR"), "ko-KR", 8);
  return coverage ? `비교 과정에서는 ${coverage}를 이어서 살펴볼 수 있습니다` : undefined;
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
  return primaryFacts
    ? `${productName}の商品ページは、${context.targetCustomer}が${context.productType}を比較するときに、${primaryFacts}などの商品情報を先に確認できるように紹介する商品ページです`
    : `${productName}の商品ページは、${context.targetCustomer}が${context.productType}を比較するときに必要な商品情報を先に見られるように紹介する商品ページです`;
}

function createJapaneseWebPageCoverageScopeDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const coverage = formatDescriptionList(selectWebPageCoverageTopics(product, context, "ja-JP"), "ja-JP", 8);
  return coverage ? `比較時には${coverage}も続けて見られます` : undefined;
}

function createJapaneseWebPageDecisionDescription(context: DescriptionContext): string | undefined {
  const details = unique([
    context.benefitPhrase ? `${context.benefitPhrase}のベネフィット` : undefined,
    context.ingredientPhrase ? `${context.ingredientPhrase}の成分/技術` : undefined,
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

function createEnglishWebPageCoverageLead(product: PdpProductSignal, productName: string, context: DescriptionContext): string {
  const primaryFacts = formatDescriptionList(selectWebPagePrimaryProductFacts(product, context, "en-US"), "en-US", 3);
  return primaryFacts
    ? `This ${productName} product page introduces and summarizes specific product facts about the ${lowercaseEnglishProductType(context.productType)} for ${context.targetCustomer}, starting with product information such as ${primaryFacts}`
    : `This ${productName} product page introduces and summarizes specific product facts about the ${lowercaseEnglishProductType(context.productType)} for ${context.targetCustomer}`;
}

function createEnglishWebPageCoverageScopeDescription(product: PdpProductSignal, context: DescriptionContext): string | undefined {
  const coverage = formatDescriptionList(selectWebPageCoverageTopics(product, context, "en-US"), "en-US", 8);
  return coverage ? `For comparison, the page also extends into ${coverage}` : undefined;
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
    context.ingredientPhrase ? "ingredient and technology questions" : undefined,
    context.usage ? "routine-use decisions" : undefined,
    context.reviewPhrase ? "use-feel and review interpretation" : undefined,
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
      context.usage ? "사용법" : undefined,
      context.reviewPhrase ? "리뷰 표현" : undefined,
      product.faq.length > 0 ? "FAQ" : undefined,
      context.usage ? "HowTo" : undefined,
      product.options.length > 0 ? "옵션/용량" : undefined,
      product.price ? "가격/구매 정보" : undefined,
      context.reportedDetail ? "측정/평가 수치" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  if (locale === "ja-JP") {
    return unique([
      context.benefitPhrase ? "ベネフィット" : undefined,
      context.ingredientPhrase ? "成分/技術" : undefined,
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
    context.ingredientPhrase ? "ingredient and technology details" : undefined,
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
      context.ingredientPhrase ? `${context.ingredientPhrase}の成分/技術` : undefined,
      context.usage ? "使用ルーティン" : undefined,
      context.reviewPhrase ? `${context.reviewPhrase}のレビュー表現` : undefined,
      product.options.length > 0 ? "バリエーション/容量" : undefined,
      context.reportedDetail ? "測定/評価結果" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  return unique([
    context.benefitPhrase ? `${context.benefitPhrase} benefits` : undefined,
    context.ingredientPhrase ? `${context.ingredientPhrase} ingredients or technologies` : undefined,
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
      context.ingredientPhrase ? "成分/技術の理解" : undefined,
      context.usage ? "使用順序" : undefined,
      context.reviewPhrase ? "使用感判断" : undefined,
      product.options.length > 0 ? "バリエーション選択" : undefined,
      context.reportedDetail ? "数値結果の解釈" : undefined
    ].filter((value): value is string => Boolean(value)));
  }

  return unique([
    context.benefitPhrase ? "benefit comparison" : undefined,
    context.ingredientPhrase ? "ingredient or technology context" : undefined,
    context.usage ? "routine use" : undefined,
    context.reviewPhrase ? "use-feel and review interpretation" : undefined,
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
  usage?: string;
  reviewKeywords: string[];
  reviewPhrase?: string;
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
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const benefits = selectPublicBenefitSignals(product, locale, localizedTerms).slice(0, 5);
  const ingredients = selectKeyIngredients(product, 5);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 2);
  const reviewKeywords = hasPublicReviewEvidence(product, locale) ? selectPublicReviewKeywords(product, locale).slice(0, 5) : [];
  const representativeReviews = selectRepresentativeReviewPhrases(product, locale, 2);
  const sourceBackedSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 5);
  const sourceFactSentences = selectSourceBackedClaimSentences(product, 5);
  const reportedDetails = selectReportedDetails(product, 2);
  const sourceFaq = selectSourceFaqForPublicUse(product.faq, locale, productName);
  const benefitFaqSentence = selectFaqSentenceForDescription(sourceFaq, locale, ["benefit", "suitability"], 220);
  const ingredientFaqSentence = selectFaqSentenceForDescription(sourceFaq, locale, ["ingredient"], 240);
  const pageFactPhrase = first(sourceFactSentences) ?? first(sourceBackedSentences);

  return {
    productType,
    targetCustomer: inferTargetCustomer(product, locale),
    benefits,
    benefitPhrase: formatDescriptionList(benefits, locale, 4),
    ingredients,
    ingredientPhrase: formatDescriptionList(ingredients, locale, 4),
    ingredientDetail: formatDescriptionList(ingredientDetails, locale, 2),
    usage: first(selectUsageInstructions(product)) ?? first(optimizedUsageSteps),
    reviewKeywords,
    reviewPhrase: formatDescriptionList(reviewKeywords, locale, 4),
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
      .filter((value) => !isKoreanMetaNarrationText(value) && !isEnglishMetaNarrationText(value)));
    if (sentence) {
      return locale === "ko-KR" ? sentence : trimTrailingSentencePunctuation(sentence);
    }
  }
  return undefined;
}

function createKoreanProductLeadDescription(productName: string, context: DescriptionContext, fallbackBenefit: string): string {
  const faqLead = createKoreanLeadFromBenefitFaq(productName, context);
  if (faqLead) {
    return faqLead;
  }
  const careFocus = formatKoreanCareFocus(context.benefitPhrase ?? fallbackBenefit);
  return `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(careFocus)} 돕는 ${context.productType}입니다`;
}

function createKoreanLeadFromBenefitFaq(productName: string, context: DescriptionContext): string | undefined {
  const sentence = cleanSignal(context.benefitFaqSentence ?? "");
  if (!sentence || !/[가-힣]/.test(sentence) || hasKoreanSurfaceQualityIssue(sentence)) {
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

function createKoreanProductIngredientDescription(context: DescriptionContext): string | undefined {
  if (!context.ingredientPhrase && !context.ingredientFaqSentence) {
    return undefined;
  }
  const careFocus = context.benefitPhrase ? formatKoreanCareFocus(context.benefitPhrase) : undefined;
  if (context.ingredientPhrase) {
    return careFocus
      ? `${context.ingredientPhrase} 등 핵심 성분/기술이 ${appendKoreanObjectParticle(careFocus)} 뒷받침합니다`
      : `${context.ingredientPhrase} 등 핵심 성분/기술이 포뮬러의 특징을 이룹니다`;
  }
  return context.ingredientFaqSentence ? ensureKoreanSentence(context.ingredientFaqSentence) : undefined;
}

function formatKoreanCareFocus(value: string): string {
  const items = cleanSignal(value)
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /(?:케어|개선|강화|진정|세정|컨트롤|리프팅)$/.test(item) ? item : `${item} 케어`);
  return formatKoreanListForSentence(unique(items).join(", "));
}

function createProductIngredientDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (!context.ingredientPhrase && !context.ingredientDetail) {
    return undefined;
  }

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
        return `処方説明では${normalizeFormulaDetailText(context.ingredientDetail)}を確認できます`;
      }
      return context.ingredientDetail
        ? `主な成分・技術は${context.ingredientPhrase}で、成分説明は${context.ingredientDetail}に焦点を当てています`
        : `主な成分・技術は${context.ingredientPhrase}です`;
    case "en-GB":
    case "en-US":
    default:
      if (!context.ingredientPhrase && context.ingredientDetail) {
        return `The formula includes ${formatEnglishFactComplement(normalizeFormulaDetailText(context.ingredientDetail))}`;
      }
      return context.ingredientDetail
        ? `The formula highlights ${context.ingredientPhrase}; the active-ingredient story focuses on ${context.ingredientDetail}`
        : `The formula highlights ${context.ingredientPhrase}`;
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
  const topics = formatDescriptionList(extractEvidenceTopics(cleanEvidence), locale, 3);
  if (locale === "ko-KR") {
    const metricFact = createEvidenceMetricFact(evidence, locale);
    const evidenceSentence = metricFact ? createKoreanEvidenceFactSentence(metricFact) : createKoreanEvidenceContentSentence(cleanEvidence);
    return topics
      ? `측정/평가 정보에서는 ${topics} 관련 결과를 함께 참고할 수 있습니다`
      : createKoreanWebPageEvidenceDescription(evidenceSentence);
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
  return [
    assessment,
    sample ? `of ${sample}` : undefined,
    duration ? `after ${/\bof\s+(?:daily\s+)?use\b/i.test(duration) ? duration : `${duration} of use`}` : undefined,
    dailyUse ? "with daily use" : undefined
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
    ? `측정/평가 정보에서는 ${evidencePhrase}를 참고할 수 있습니다`
    : "측정/평가 정보에서는 페이지에 공개된 결과를 참고할 수 있습니다";
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

function createLocalizedReviewDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (context.representativeReviewPhrase) {
    switch (locale) {
      case "ko-KR":
        return context.reviewPhrase
          ? `리뷰에서는 ${context.reviewPhrase} 같은 사용감 표현이 반복됩니다`
          : `대표 고객 리뷰에서는 ${context.representativeReviewPhrase} 같은 사용감 표현이 확인됩니다`;
      case "ja-JP":
        return `代表的なレビューでは${context.representativeReviewPhrase}のように語られ${context.reviewPhrase ? `、${context.reviewPhrase}などの反復表現も確認できます` : ""}`;
      case "en-GB":
      case "en-US":
      default:
        return `Representative customer reviews describe it as ${context.representativeReviewPhrase}${context.reviewPhrase ? `, with repeated review language such as ${context.reviewPhrase}` : ""}`;
    }
  }

  if (!context.reviewPhrase) {
    return undefined;
  }

  return fallback(locale, {
    "ko-KR": `리뷰에서는 ${context.reviewPhrase} 같은 사용감 표현이 반복됩니다`,
    "ja-JP": `レビューでは${context.reviewPhrase}などの表現が見られ、使用感と期待できるケア文脈を補足します`,
    "en-US": `Customer reviews mention ${context.reviewPhrase}, which supports the product's texture, moisture, firmness, and visible skin-care context`,
    "en-GB": `Customer reviews mention ${context.reviewPhrase}, which supports the product's texture, moisture, firmness, and visible skin-care context`
  });
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
      [/lotion|로션/i, "로션"],
      [/cream|크림/i, "크림"],
      [/serum|세럼|앰플|에센스/i, "세럼"],
      [/toner|토너|스킨/i, "토너"],
      [/cleanser|클렌저|폼/i, "클렌저"],
      [/mask|마스크/i, "마스크"]
    ],
    "ja-JP": [
      [/body\s*lotion|ボディローション/i, "ボディローション"],
      [/lotion|ローション/i, "ローション"],
      [/cream|クリーム/i, "クリーム"],
      [/serum|美容液|セラム/i, "美容液"],
      [/toner|化粧水/i, "化粧水"],
      [/cleanser|洗顔|クレンザー/i, "クレンザー"],
      [/mask|マスク/i, "マスク"]
    ],
    "en-US": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
      [/lotion|로션|ローション/i, "Lotion"],
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ],
    "en-GB": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
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
  const text = [product.category, product.description, ...product.benefits, ...product.sourceTexts].filter(Boolean).join(" ");
  const evidenceBackedTarget = inferEvidenceBackedTargetCustomer(product, locale);
  if (evidenceBackedTarget) {
    return evidenceBackedTarget;
  }

  const recommendedSkinType = inferRecommendedSkinType(product, locale);

  if (recommendedSkinType) {
    return fallback(locale, {
      "ko-KR": `${recommendedSkinType} 고객`,
      "ja-JP": `${recommendedSkinType}のお客様`,
      "en-US": `customers with ${recommendedSkinType}`,
      "en-GB": `customers with ${recommendedSkinType}`
    });
  }

  if (/fine\s*lines?|wrinkles?|aging|anti[-\s]?aging|dullness|firm|elastic|texture|resilien|주름|탄력|피부결|ハリ|キメ/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "탄력, 피부결, 노화 징후 케어를 비교하는 고객",
      "ja-JP": "ハリ、キメ、エイジングサインのケアを比較するお客様",
      "en-US": "customers comparing visible-aging, firmness, texture, and hydration benefits",
      "en-GB": "customers comparing visible-ageing, firmness, texture, and hydration benefits"
    });
  }
  if (/dry|건조|乾燥/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "건조함이 고민인 고객",
      "ja-JP": "乾燥が気になるお客様",
      "en-US": "customers concerned with dryness",
      "en-GB": "customers concerned with dryness"
    });
  }
  if (/sensitive|민감|敏感/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "민감한 피부 루틴을 찾는 고객",
      "ja-JP": "敏感肌のルーティンを探すお客様",
      "en-US": "customers looking for a sensitive-skin routine",
      "en-GB": "customers looking for a sensitive-skin routine"
    });
  }
  if (/firm|elastic|탄력|ハリ/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "탄력 케어를 원하는 고객",
      "ja-JP": "ハリ感を求めるお客様",
      "en-US": "customers looking for firming care",
      "en-GB": "customers looking for firming care"
    });
  }

  return fallback(locale, {
    "ko-KR": "상품의 핵심 효능과 사용법을 빠르게 확인하려는 고객",
    "ja-JP": "商品の主な特徴と使い方を知りたいお客様",
    "en-US": "customers comparing the product's key benefits and routine fit",
    "en-GB": "customers comparing the product's key benefits and routine fit"
  });
}

function inferEvidenceBackedTargetCustomer(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const text = allProductEvidenceText(product);
  if (!hasVisibleAgingTargetConcern(text)) {
    return undefined;
  }
  const ageSample = extractTargetAudienceAgeSample(text, locale);
  const concernTarget = inferConcernBasedTargetCustomer(text, locale);

  if (!ageSample && !concernTarget) {
    return undefined;
  }

  if (locale === "ko-KR") {
    if (ageSample && concernTarget) {
      return `${concernTarget} ${ageSample}`;
    }
    if (ageSample) {
      return ageSample;
    }
    return concernTarget ? `${concernTarget} 고객` : undefined;
  }

  if (locale === "ja-JP") {
    if (ageSample && concernTarget) {
      return `${concernTarget}で、${ageSample}`;
    }
    return ageSample ?? concernTarget;
  }

  if (ageSample && concernTarget) {
    return `${concernTarget}, especially ${ageSample} reflected in the cited test population`;
  }
  return ageSample ?? concernTarget;
}

function hasVisibleAgingTargetConcern(value: string): boolean {
  return /(?:노화|안티에이징|주름|팔자|미간|이마|목\s*주름|탄력|리프팅|피부\s*밀도|aging|anti[-\s]?aging|wrinkles?|fine\s*lines?|firm|elastic|lifting|resilien|density)/i.test(cleanSignal(value));
}

function isSpecificTargetCustomer(value: string | undefined, locale: PdpGeoLocale): boolean {
  const text = cleanSignal(value ?? "");
  if (!text) {
    return false;
  }
  const genericTargets: Record<PdpGeoLocale, RegExp> = {
    "ko-KR": /상품의\s*핵심\s*효능|사용법을\s*빠르게\s*확인/,
    "ja-JP": /商品の主な特徴/,
    "en-US": /key benefits and routine fit|product's key benefits/i,
    "en-GB": /key benefits and routine fit|product's key benefits/i
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

function inferConcernBasedTargetCustomer(value: string, locale: PdpGeoLocale): string | undefined {
  const text = cleanSignal(value);
  if (hasVisibleAgingTargetConcern(text)) {
    return fallback(locale, {
      "ko-KR": "탄력 저하와 주름 등 노화 징후가 고민인",
      "ja-JP": "ハリ低下やシワなどのエイジングサインが気になるお客様",
      "en-US": "customers comparing visible-aging, firmness, and wrinkle care",
      "en-GB": "customers comparing visible-ageing, firmness, and wrinkle care"
    });
  }
  if (/(?:장벽|피부\s*장벽|건조|수분|보습|barrier|dryness|dry\s*skin|hydration|moisture)/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "건조함과 피부 장벽 약화가 고민인",
      "ja-JP": "乾燥や肌バリアの低下が気になるお客様",
      "en-US": "customers concerned with dryness and skin-barrier support",
      "en-GB": "customers concerned with dryness and skin-barrier support"
    });
  }
  if (/(?:민감|저자극|sensitive|irritation|hypoallergenic)/i.test(text)) {
    return fallback(locale, {
      "ko-KR": "민감 피부 루틴을 찾는",
      "ja-JP": "敏感肌向けのルーティンを探すお客様",
      "en-US": "customers looking for a sensitive-skin routine",
      "en-GB": "customers looking for a sensitive-skin routine"
    });
  }
  return undefined;
}

function inferRecommendedSkinType(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const semanticSkinType = formatDescriptionList(product.semanticFacts?.skinTypes ?? [], locale, 3);
  if (semanticSkinType) {
    return semanticSkinType;
  }

  const text = [product.category, product.description, ...product.benefits, ...product.effects, ...product.ingredients, ...product.sourceTexts]
    .filter(Boolean)
    .join(" ");

  const koreanRecommended = text.match(/추천\s*피부\s*타입\s*[:：]?\s*([가-힣\s또는및/·,]+?)(?=$|[.。！？\n]|Barrier|효능|핵심|사용법|성분)/i)?.[1];
  if (koreanRecommended) {
    const skinTypes = normalizeKoreanSkinTypeList(koreanRecommended);
    if (skinTypes) {
      return skinTypes;
    }
  }

  if (locale === "ko-KR") {
    if (/건조\s*피부|건성/.test(text) && /민감\s*피부|민감성/.test(text)) {
      return "건조 피부 또는 민감 피부";
    }
    if (/건조\s*피부|건성/.test(text)) {
      return "건조 피부";
    }
    if (/민감\s*피부|민감성/.test(text)) {
      return "민감 피부";
    }
  }

  if (/dry\s+skin/i.test(text) && /sensitive\s+skin/i.test(text)) {
    return locale === "ja-JP" ? "乾燥肌または敏感肌" : "dry or sensitive skin";
  }
  if (/dry\s+skin/i.test(text)) {
    return locale === "ja-JP" ? "乾燥肌" : "dry skin";
  }
  if (/sensitive\s+skin/i.test(text)) {
    return locale === "ja-JP" ? "敏感肌" : "sensitive skin";
  }

  return undefined;
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
    .filter((value) => !isProductEntityOnlySignal(value, product))
    .filter((value) => !isLowQualityBenefitSignal(value))
    .filter((value) => isBenefitCompatibleWithProduct(value, product))
    .filter(isUsefulPublicListValue))
    .slice(0, 10);
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
    ...(product.semanticFacts?.benefits ?? []).flatMap(extractBenefitSignalCandidates),
    ...(product.semanticFacts?.effects ?? []).flatMap(extractBenefitSignalCandidates),
    ...faqBenefitText.flatMap(extractBenefitSignalCandidates),
    ...product.benefits.flatMap(extractBenefitSignalCandidates),
    ...product.effects.flatMap(extractBenefitSignalCandidates),
    ...[product.description].filter((value): value is string => Boolean(value)).flatMap(extractBenefitSignalCandidates),
    ...product.sourceTexts.slice(0, 30).flatMap(extractBenefitSignalCandidates)
  ].map(normalizeBenefitSignal).filter((value): value is string => Boolean(value)).filter(isUsefulBenefitSignal)).slice(0, 10);
}

function selectKeyIngredients(product: PdpProductSignal, limit: number): string[] {
  const faqEvidence = product.faq.flatMap((item) => [item.question, item.answer]);
  const ingredientEvidenceTexts = [
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? []),
    ...faqEvidence,
    ...product.sourceTexts.slice(0, 80)
  ];
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
    /진세노믹스|ginsenomics/i.test(haystack) ? "진세노믹스" : undefined,
    /진생\s*펩타이드|진생펩타이드|ginseng peptide/i.test(haystack) ? "진생펩타이드" : undefined,
    /진생\s*레티놀|진생레티놀|ginseng retinol/i.test(haystack) ? "진생레티놀" : undefined,
    /500[-\s]?hour(?:\s+aged)?\s+ginseng/i.test(haystack) ? "500-hour aged ginseng" : undefined,
    /korean herb extract/i.test(haystack) ? "Korean herb extract" : undefined,
    /korean ginseng actives|ginsenomics/i.test(haystack) ? "Korean Ginseng Actives (Ginsenomics)" : undefined,
    /ginseng peptide/i.test(haystack) ? "Ginseng Peptide" : undefined,
    /retinol/i.test(haystack) ? "Retinol-infused capsules" : undefined,
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
  const normalizedFromSourceTexts = product.sourceTexts.slice(0, 80)
    .flatMap(splitIngredientSignal)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value))
    .filter(isGenericSourceIngredientSignal);

  return dedupeIngredientSignals([
    ...semanticIngredients,
    ...evidenceIngredientSubjects,
    ...detected,
    ...normalizedFromIngredients,
    ...(semanticIngredients.length === 0 ? normalizedFromSourceTexts : [])
  ])
    .filter((value) => isUsefulKeyIngredientSignal(value, product))
    .slice(0, limit);
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
  if (text.split(/\s+/).length >= 5 && !hasIngredientAnchor) {
    return true;
  }
  return /(?:고객|분|피부\s*타입|타입\s*전용|전용|제품|상품)$/i.test(text) && !hasIngredientAnchor;
}

function hasSpecificIngredientNameAnchor(value: string): boolean {
  return /(?:성분|원료|기술|복합체|추출|오일|펩타이드|비타민|유도체|발효|사포닌|콜라겐|세라마이드|히알루론산|하이알루론산|레티놀|나이아신아마이드|징크|판테놀|베타인|프로바이오틱스|ingredient|formula|technology|complex|extract|oil|peptide|vitamin|derivative|ferment|saponin|collagen|ceramide|hyaluronic|retinol|niacinamide|zinc|panthenol|betaine|probiotics?|ginseng|panax)/i.test(cleanSignal(value));
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
  const hasCompressedHyaluronic = uniqueValues.some((value) => /압축\s*히알루론산/i.test(value));
  const hasSpecificGinseng = uniqueValues.some((value) =>
    /500[-\s]?hour|korean herb extract|korean ginseng actives|ginsenomics|ginseng peptide|panax ginseng|진세노믹스|진생\s*펩타이드|진생\s*레티놀/i.test(value)
  );

  return uniqueValues.filter((value) => {
    if (hasRetinolCapsule && /^retinol$/i.test(value)) {
      return false;
    }
    if (hasDenseCeramideCapsule && /^세라마이드$/i.test(value)) {
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
    .filter((value) => !hasTruncationMarker(value) && !isQuestionLikeText(value))).slice(0, limit);
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
  if (/korean ginseng actives|ginsenomics/i.test(text) && /patented ingredient|rare and potent/i.test(text)) {
    return "Korean Ginseng Actives (Ginsenomics), a patented ingredient described as amplifying rare ginseng compounds";
  }
  if (/ginseng peptide/i.test(text) && /firmness|elasticity/i.test(text)) {
    return "Ginseng Peptide, described as supporting the look of skin firmness and elasticity";
  }
  if (/retinol/i.test(text) && /capsule|plump|resilien|fine line|wrinkle/i.test(text)) {
    return "Retinol-infused capsules for visible plumpness, resilience, and fine-line care";
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
      const existing = usageStepKey(item);
      return existing.includes(normalized) || normalized.includes(existing);
    })) {
      continue;
    }
    deduped.push(instruction);
  }

  return deduped.slice(0, 4);
}

function selectUsageInstructionCandidateTexts(product: PdpProductSignal): string[] {
  const sourceCandidates = [
    ...product.sourceTexts,
    ...product.ingredients,
    ...product.effects,
    ...product.benefits,
    ...product.faq.flatMap((item) => [item.question, item.answer])
  ].flatMap(extractUsageInstructionCandidatesFromMixedText);

  return unique([
    ...(product.semanticFacts?.usageSteps ?? []),
    ...product.usage,
    ...sourceCandidates
  ]);
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
  return /사용\s*방법|사용법\s*\d*|\bhow\s+to\s+use\b|\bdirections?\b|손에\s*적당량|적당량|화장솜|미온수|헹구|마무리|lather|rinse/i.test(value);
}

function usageInstructionQualityScore(value: string): number {
  const normalized = cleanSignal(value);
  return [
    /(?:적당량|dime-sized|pea-sized|small amount|appropriate amount)/i.test(normalized) ? 4 : 0,
    /(?:물과\s*함께|wet|water|거품\s*내|거품내|lather)/i.test(normalized) ? 4 : 0,
    /(?:마사지|문지르|massage|rub)/i.test(normalized) ? 3 : 0,
    /(?:헹구|마무리|rinse)/i.test(normalized) ? 3 : 0,
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
      [/^hydration$|^moisture$|^moist$|수분감|보습감/i, "수분감"],
      [/^smooth texture$|^smooth$|texture|피부결|매끄/i, "피부결"],
      [/촉촉/i, "촉촉한 사용감"],
      [/보습력/i, "보습력"],
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
    .filter((review) => !isProductNameOnlyReviewBody(review.body, product))
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
    .map((review) => normalizeRepresentativeReviewPhrase(review.body, locale))
    .filter((value): value is string => Boolean(value))).slice(0, limit);
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
  const ingredients = selectKeyIngredients(product, 3);
  const outcomes = selectPublicBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const outcomePhrase = formatDescriptionList(outcomes, locale, 4);
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : "제품";
  const targetCustomer = inferTargetCustomer(product, locale);
  const reviewPhrase = hasPublicReviewEvidence(product, locale) ? formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4) : undefined;
  const usage = first(selectUsageInstructions(product));

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
  const ingredients = selectKeyIngredients(product, 3);
  const outcomes = selectPublicBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const outcomePhrase = formatDescriptionList(outcomes, locale, 4);
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product);
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
  const ingredients = selectKeyIngredients(product, 4);
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 5);
  const reviews = hasPublicReviewEvidence(product, locale) ? selectPublicReviewKeywords(product, locale).slice(0, 4) : [];
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 4);
  const reviewPhrase = formatDescriptionList(reviews, locale, 3);

  if (locale === "ko-KR") {
    return unique([
      ingredientPhrase && benefitPhrase ? `${formatKoreanListForSentence(ingredientPhrase)} 기반 ${benefitPhrase} 케어` : undefined,
      ingredients[0] && benefits[0] ? `${ingredients[0]} ${benefits[0]} 포인트` : undefined,
      ingredients[1] && benefits[1] ? `${ingredients[1]} ${benefits[1]} 포인트` : undefined,
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
    ingredients[0] && benefits[0] ? `${benefits[0]} with ${ingredients[0]}` : undefined,
    ingredients[1] && benefits[1] ? `${benefits[1]} with ${ingredients[1]}` : undefined,
    benefitPhrase ? `${lowercaseEnglishProductType(productType)} for ${benefitPhrase}` : undefined,
    reviewPhrase ? `customer-described ${reviewPhrase}` : undefined
  ].filter((value): value is string => Boolean(value))
    .map(cleanSignal)
    .filter(isUsefulPublicListValue))
    .slice(0, limit);
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
    .map((insight, index) => createOcrBlendedBenefitContext(product, insight, locale, index))
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);
}

function createOcrBlendedBenefitContext(product: PdpProductSignal, insight: OcrEvidenceInsight, locale: PdpGeoLocale, index: number): string | undefined {
  const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "product", locale);
  const outcomes = formatDescriptionList(extractCanonicalBenefitTerms(insight.text)
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value)), locale, 3);
  const detail = trimTrailingSentencePunctuation(insight.detail);
  const detailObject = appendKoreanObjectParticle(detail);

  if (locale === "ko-KR") {
    const outcomePhrase = outcomes ?? "성분과 효능";
    const variants = [
      `${insight.topic} 설명은 ${detailObject} 바탕으로 ${outcomePhrase} 케어 맥락을 보강합니다`,
      `${insight.topic}의 ${detail} 특성은 ${productType}의 ${outcomePhrase} 선택 기준을 더 선명하게 합니다`,
      `${insight.topic} 정보는 ${productType}의 수분감, 사용감, 피부 고민 맥락과 연결됩니다`
    ];
    return variants[index % variants.length];
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
  const insights = selectOcrEvidenceInsights(product, locale, 5)
    .filter((insight) => insight.intents.includes("benefit") || insight.intents.includes("ingredient"));
  if (insights.length === 0) {
    return {};
  }

  const publicInsights = insights
    .map((insight) => createPublicOcrFaqInsight(product, insight, locale))
    .filter((item) => item.topic || item.detail || extractCanonicalBenefitTerms(item.insight.text).length > 0);
  const ingredientTopics = formatDescriptionList(unique(publicInsights
    .filter((item) => item.insight.intents.includes("ingredient"))
    .map((item) => item.topic)
    .filter((value): value is string => Boolean(value))), locale, 3);
  const topics = formatDescriptionList(unique(publicInsights
    .map((item) => item.topic)
    .filter((value): value is string => Boolean(value))), locale, 3);
  const outcomes = formatDescriptionList(unique(insights
    .flatMap((insight) => extractCanonicalBenefitTerms(insight.text))
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))), locale, 4);
  const detail = first(publicInsights
    .filter((item) => item.insight.intents.includes("ingredient"))
    .map((item) => item.detail)
    .filter((value): value is string => Boolean(value)));
  const contextTopics = ingredientTopics ?? topics;

  if (!contextTopics && !outcomes) {
    return {};
  }

  if (locale === "ko-KR") {
    const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "제품", locale);
    const semanticTopics = formatDescriptionList(selectOcrGeoExposureTopics(product, publicInsights, locale), locale, 3);
    const benefitPhrase = outcomes ?? formatDescriptionList(selectPublicBenefitSignals(product, locale), locale, 4) ?? "피부 고민 케어";
    const ingredientPhrase = semanticTopics ?? formatDescriptionList(selectKeyIngredients(product, 3), locale, 3);
    const targetCustomer = inferTargetCustomer(product, locale);
    const ingredientTopic = ingredientPhrase ? appendKoreanTopicParticle(formatKoreanListForSentence(ingredientPhrase)) : undefined;
    const productTypeObject = appendKoreanObjectParticle(productType);
    const detailSummary = normalizeKoreanOcrSemanticDetail(detail);

    return {
      benefit: ingredientTopic
        ? `${ingredientTopic} ${appendKoreanObjectParticle(benefitPhrase)} 뒷받침합니다${detailSummary ? `. ${detailSummary}` : ""}`
        : `${benefitPhrase} 정보는 ${targetCustomer}이 ${productTypeObject} 비교할 때 확인할 핵심 선택 기준입니다`,
      ingredient: ingredientPhrase
        ? `${ingredientPhrase}는 ${benefitPhrase}와 연결되어 ${productType} 선택 기준이 됩니다${detailSummary ? `. ${detailSummary}` : ""}`
        : undefined,
      usage: ingredientPhrase
        ? `사용 루틴 답변은 ${ingredientPhrase} 기반의 ${benefitPhrase} 케어와 사용 후 체감 맥락을 함께 설명합니다`
        : undefined
    };
  }
  if (locale === "ja-JP") {
    const usageOutcome = outcomes ?? "確認できる成分とベネフィット";
    return {
      benefit: contextTopics
        ? `商品詳細の${contextTopics}説明は${outcomes ?? "成分とベネフィット"}の根拠を補足します`
        : `商品詳細の根拠は${outcomes ?? "成分とベネフィット"}を補足します`,
      ingredient: detail
        ? `成分説明では${contextTopics ?? "主要成分"}と${truncate(detail, 120)}の内容から処方上の役割を具体化します`
        : contextTopics ? `成分説明では${contextTopics}の情報から処方上の役割を具体化します` : undefined,
      usage: contextTopics ? `使い方の説明には${contextTopics}から分かる${usageOutcome}の文脈を加え、使用後の感触を補足します` : undefined
    };
  }
  const benefitOutcome = outcomes ?? "source-backed formula and benefit";
  const usageOutcome = outcomes ?? "source-backed formula and use-feel";
  return {
    benefit: contextTopics
      ? `${contextTopics} connects with ${benefitOutcome} in the product's supported care story`
      : `The product's supported care story focuses on ${benefitOutcome}`,
    ingredient: detail
      ? `${contextTopics ?? "The highlighted formula elements"} are described as ${normalizeIngredientRolePhrase(detail)}`
      : contextTopics ? `The highlighted formula elements, ${contextTopics}, support ${outcomes ?? "the product's care benefits"}` : undefined,
    usage: contextTopics ? `${contextTopics} helps frame routine use with ${usageOutcome} cues` : undefined
  };
}

function selectOcrGeoExposureTopics(product: PdpProductSignal, insights: PublicOcrFaqInsight[], locale: PdpGeoLocale): string[] {
  const candidates = unique([
    ...insights.flatMap((item) => [
      item.topic,
      ...extractCanonicalBenefitTerms(item.insight.text).map((value) => localizePublicBenefitSignal(value, locale)),
      normalizeIngredientSignal(item.insight.text)
    ]),
    ...selectKeyIngredients(product, 4),
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
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product);
  const productType = rawProductType ? localizeProductTypeForLocale(rawProductType, locale) : fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const ingredients = unique([
    ...extractClaimIngredientTerms(sourceSentence),
    ...selectKeyIngredients(product, 3)
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
    `${productType} 포뮬러는 ${ingredientObject} 중심으로 ${outcomePhrase} 케어 맥락을 제시합니다`,
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
  return `고객 리뷰의 ${reviewPhrase} 표현은 ${productType}의 사용감, 만족도, ${outcomePhrase} 체감을 판단할 때 참고할 수 있습니다`;
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
  return `Customer reviews mentioning ${reviewPhrase} add use-feel, satisfaction, and ${outcomePhrase} detail for the ${lowercaseEnglishProductType(productType)}`;
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

function selectStructuredReportedMetricDetails(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return unique((product.semanticFacts?.metricClaims ?? [])
    .map((claim) => formatSemanticMetricClaim(claim, locale))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNonCitationEvidenceArtifact(value) && !hasTruncationMarker(value) && !isQuestionLikeText(value)))
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
    semanticMetricContextEntry("sample", claim.sample, locale),
    semanticMetricContextEntry("period", claim.period, locale),
    semanticMetricContextEntry("method", claim.method, locale),
    semanticMetricContextEntry("caveat", claim.caveat, locale)
  ].filter((value): value is string => Boolean(value));

  return entries.join(", ");
}

function semanticMetricContextEntry(kind: "timing" | "sample" | "period" | "method" | "caveat", value: string | undefined, locale: PdpGeoLocale): string | undefined {
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
      sample: "대상",
      period: "기간",
      method: "방법"
    },
    "ja-JP": {
      timing: "時点",
      sample: "対象",
      period: "期間",
      method: "方法"
    },
    "en-US": {
      timing: "timing",
      sample: "sample",
      period: "period",
      method: "method"
    },
    "en-GB": {
      timing: "timing",
      sample: "sample",
      period: "period",
      method: "method"
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
  return /%|\d+(?:\.\d+)?\s*배|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|women|men|subjects?|participants?|reviews?|ratings?)\b|평점\s*\d|리뷰\s*\d|\d+(?:\.\d+)?\s*(?:명|회|주|일|시간)|사용\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/i.test(value);
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
  if (/^anti[-\s]?aging moisturizing visibly firming$/i.test(cleaned)) {
    return ["anti-aging, moisturizing, and visibly firming care"];
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
  if (/^anti[-\s]?aging moisturizing visibly firming$/i.test(cleaned)) {
    return "anti-aging, moisturizing, and visibly firming care";
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
      [/low[-\s]?irritation|gentle|mild|마찰\s*자극|저자극|자극/i, "저자극 세안"],
      [/fine\s*dust|ultra[-\s]?fine\s*dust|pollution|초미세먼지/i, "초미세먼지 세정"],
      [/pore\s*(?:waste|impurit|cleansing)|모공\s*속\s*노폐물|노폐물/i, "모공 속 노폐물 세정"],
      [/micro\s*bubble|bubble|마이크로\s*버블|버블|거품/i, "마이크로 버블"],
      [/cleans(?:e|ing)|wash|세정|세안/i, "세정력"],
      [/sebum|oil control|oil|피지|유분/i, "유분 컨트롤"],
      [/smooth(?:ness)?|texture|피부결|매끄/i, "피부결"],
      [/brightening|even-looking tone|광채|화사/i, "광채"],
      [/cooling sensation|cooling|쿨링|시원|산뜻/i, "쿨링감"]
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
    [/low[-\s]?irritation|gentle|mild|마찰\s*자극|저자극|자극/i, "low-irritation cleansing"],
    [/fine\s*dust|ultra[-\s]?fine\s*dust|pollution|초미세먼지/i, "fine-dust cleansing"],
    [/pore\s*(?:waste|impurit|cleansing)|모공\s*속\s*노폐물|노폐물/i, "pore waste cleansing"],
    [/micro\s*bubble|bubble|마이크로\s*버블|버블|거품/i, "micro-bubble foam"],
    [/cleans(?:e|ing)|wash|세정|세안/i, "cleansing power"],
    [/sebum|oil control|oil|피지|유분/i, "oil control"],
    [/smooth(?:ness)?|texture|피부결|매끄|キメ/i, "smooth texture"],
    [/brightening|even-looking tone|광채|화사|透明感/i, "brightening"],
    [/cooling|쿨링|시원|산뜻/i, "cooling sensation"]
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
  if (/[.:]/.test(normalized)) {
    return false;
  }
  return /benefit|care|hydration|moisture|firm|elastic|wrinkle|fine line|plump|resilien|barrier|smooth|texture|bright|cleanse|cleansing|bubble|보습|수분|탄력|피부결|광채|저자극|세정|세안|거품|버블|노폐물|초미세먼지|保湿|うるおい|ハリ|キメ/i.test(normalized);
}

function normalizeUsageInstruction(value: string): string {
  const normalized = extractUsageInstructionFromMixedEvidence(stripLeadingUsageStepMarkers(stripSourceSectionLabel(value)
    .replace(/\bStep\s+\d+\b\.?/gi, "")
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:the|a|an|your|this|it|of|serum|cream|toner|product)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (!/[가-힣]/.test(text) || hasConcreteKoreanUsageAction(text)) {
    return false;
  }
  return /(?:타\s*제품|사용해\s*봤|사용해봤|사용했|썼는데|써\s*봤|써봤|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)/i.test(text);
}

function isSafetyOrTestClaimUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:테스트|시험)\s*완료|사용성\s*테스트|피부\s*자극\s*테스트|피부\s*테스트|안자극|하이포알러지|논코메도제닉|민감\s*피부\s*대상|소아와?\s*피부\s*테스트|소아\s*피부\s*테스트/i.test(text);
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
  return sanitizeCategory(product.category) ?? productTypeFromName(product.name);
}

function productTypeFromName(value: string): string | undefined {
  const name = cleanSignal(value);
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
  const explicitTechnologyPhrase = normalizeExplicitIngredientTechnologyPhrase(text);
  if (explicitTechnologyPhrase) {
    return explicitTechnologyPhrase;
  }
  if (/ginseng peptide/i.test(text)) {
    return "Ginseng Peptide";
  }
  if (/retinol/i.test(text) && /capsule/i.test(text)) {
    return "Retinol-infused capsules";
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
  if (normalized.length < 18 || normalized.length > 280) {
    return false;
  }
  if (normalized.split(/\s+/).length < 4 && !hasConcreteKoreanUsageAction(normalized)) {
    return false;
  }
  if (isEvidenceOnlyUsageCandidate(normalized) || isQuestionLikeText(normalized)) {
    return false;
  }
  if (isNonInstructionUsageText(normalized)) {
    return false;
  }
  if (isProductDescriptionUsageCandidate(normalized)) {
    return false;
  }
  if (isSensoryOnlyUsageInstruction(normalized)) {
    return false;
  }
  return hasExplicitUsageAction(normalized);
}

function isProductDescriptionUsageCandidate(value: string): boolean {
  const text = cleanSignal(value);
  if (!/[가-힣]/.test(text) || hasConcreteKoreanUsageAction(text)) {
    return false;
  }

  return /사용할\s*수\s*있는|사용\s*가능/.test(text)
    || /(?:제품|상품|클렌저|클렌징|폼|토너|크림|세럼|로션|미스트|포뮬라|성분|캡슐)[^.!?。！？\n]{0,100}(?:제시|설명|표방|함유|구성|전달|위한|입니다|합니다|된다|됩니다)/.test(text);
}

function hasConcreteKoreanUsageAction(value: string): boolean {
  return hasKoreanInstructionVerb(value);
}

function hasKoreanInstructionVerb(value: string): boolean {
  const text = cleanSignal(value);
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|사용\s*(?:해|하세요|합니다|하십시오|한다|하시|할\s*때)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
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
  return /보습|흡수|탄력|피부결|순한|만족|촉촉|매끄|광채|texture|smooth|hydration|moist|moisture|firm|elastic|lightweight|rich|absorbs|glow|plump|うるおい|保湿|ハリ|なじみ|満足/i.test(normalized);
}

function isMeaningfulReviewBody(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 20) {
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
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ].filter((value): value is string => Boolean(value)).map(cleanSignal).join(" ");
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
  return /[?？]$/.test(text) || /(인가요|나요|까요|무엇인가요|어떤가요)\s*[?？]?$/.test(text);
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
  if (/\b(?:hydration|hydrate|moisture|moisturizing|moisturising|moist|보습|수분감|うるおい|保湿)\b/.test(key)) {
    return "hydration";
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
    quickFactSentence(locale, "Key ingredients", selectKeyIngredients(product, 5).join(", ")),
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
  const ingredients = formatDescriptionList(selectKeyIngredients(product, 3), locale, 3);
  const targetCustomer = guidance.useTargetCustomerContext ? createTargetCustomerProperty(product, locale) : undefined;
  const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "product", locale);

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

  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 6);
  const targetCustomer = guidance.useTargetCustomerContext ? inferTargetCustomer(product, locale) : undefined;
  const ingredients = selectKeyIngredients(product, 3);
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
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 6);
  const targetCustomer = guidance.useTargetCustomerContext ? inferTargetCustomer(product, locale) : undefined;
  const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "제품", locale);
  const ingredients = selectKeyIngredients(product, 3);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
  const usage = first(selectUsageInstructions(product).flatMap(splitUsageInstruction));
  const expressionPhrases = selectGroundedExpressionPhrases(product, locale, 6);
  const ocrBenefitContexts = createOcrBlendedBenefitContexts(product, locale);

  const baseBullets = benefits.map((benefit, index) => {
    const benefitObject = appendKoreanObjectParticle(benefit);
    const contextSentence = targetCustomer && index === 0
      ? `${targetCustomer}이 ${appendKoreanObjectParticle(productType)} 선택할 때 ${benefitObject} 우선 검토하는 효능 축입니다`
      : `${benefit} 케어는 상품 정보에서 반복적으로 나타나는 효능 포인트입니다`;
    const ingredientSentence = ingredientPhrase && index % 3 === 0
      ? `${formatKoreanListForSentence(ingredientPhrase)} 성분/기술과 함께 보면 ${benefit}의 성분 맥락이 더 분명해집니다`
      : undefined;
    const reviewSentence = reviewPhrase && index % 3 === 1
      ? `리뷰 표현인 ${reviewPhrase}는 ${benefit}의 사용감 맥락을 보완합니다`
      : undefined;
    const expressionSentence = index === 0 ? first(expressionPhrases) : undefined;
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

function isPublicBenefitSectionBullet(value: string): boolean {
  const text = stripPublicListMarker(cleanSignal(value));
  if (!text || isLowQualityPublicEvidenceText(text) || hasFaqCitationNoise(text)) {
    return false;
  }
  return !(/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(text)
    && /(?:임상|인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|결과|clinical|study|self[-\s]?assessment|instrumental|participants?|subjects?|women|men|users?)/i.test(text));
}

function createIngredientsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const ingredients = selectKeyIngredients(product, 8);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 3);
  const fullIngredients = selectPublicFullIngredientStatements(product, locale, 1);
  const values = unique([
    ...ingredients,
    ...ingredientDetails,
    ...fullIngredients
  ])
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
  if (!text || isLowQualityPublicEvidenceText(text) || hasFaqCitationNoise(text)) {
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

  return productScopedSteps.map((step) => rewriteUsageStep(step, locale));
}

function selectSupplementalStepwiseUsageInstructions(product: PdpProductSignal): string[] {
  return unique(product.sourceTexts
    .filter(hasSupplementalUsageInstructionCue)
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
    if (!key || seen.has(key) || results.some((item) => {
      const existing = usageStepKey(item);
      return existing.includes(key) || key.includes(existing);
    })) {
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
    case "ja-JP":
    case "en-GB":
    case "en-US":
    default:
      return ensurePublicSentence(stepWithEntity, locale).replace(/\.$/, "");
  }
}

function createHowToUseSection(product: PdpProductSignal, locale: PdpGeoLocale, optimizedUsageSteps: string[]): string {
  const usage = optimizedUsageSteps.length > 0 ? optimizedUsageSteps : selectUsageInstructions(product);
  return usage.length > 0 ? usage.map((value, index) => `${index + 1}. ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 사용법 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できる使用方法が十分ではありません。",
    "en-US": "The product JSON does not include enough usage instructions.",
    "en-GB": "The product JSON does not include enough usage instructions."
  });
}

function createFaqSection(faq: PdpGeoFaqItem[], locale: PdpGeoLocale): string {
  if (faq.length === 0) {
    return fallback(locale, {
      "ko-KR": "FAQ 생성을 위한 질문/답변 근거가 충분하지 않습니다.",
      "ja-JP": "FAQ生成に必要な質問・回答の根拠が十分ではありません。",
      "en-US": "The product JSON does not include enough FAQ evidence.",
      "en-GB": "The product JSON does not include enough FAQ evidence."
    });
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
  const usage = first(selectUsageInstructions(product));
  const optimizedUsage = first(optimizedUsageSteps) ?? usage;
  const ingredient = formatDescriptionList(selectKeyIngredients(product, 3), locale, 3);
  const benefit = first(selectPublicBenefitSignals(product, locale));
  const evidence = selectEvidenceSignal(product, locale);
  const reviewSignals = hasPublicReviewEvidence(product, locale) ? selectPublicReviewKeywords(product, locale).slice(0, 3).join(", ") : "";
  const sourceFaqIntents = product.faq.flatMap(classifySourceFaqIntent);
  const sourceFaq = selectSourceFaqForPublicUse(product.faq, locale, productName);
  const sourcePublicIntentSet = new Set(sourceFaq.flatMap(classifySourceFaqIntent));
  const ocrFaqContexts = createOcrFaqBlendContexts(product, locale);
  const recommendedSkinType = inferRecommendedSkinType(product, locale);
  const inferredTargetCustomer = inferTargetCustomer(product, locale);
  const hasSpecificTargetCustomer = isSpecificTargetCustomer(inferredTargetCustomer, locale);
  const textureFinish = selectTextureFinishSignal(product, locale);
  const routineSynergy = selectRoutineSynergySignal(product, locale);
  const variantComparison = selectVariantComparisonSignal(product, locale);
  const faq: PdpGeoFaqItem[] = [];

  if (benefit && !sourcePublicIntentSet.has("benefit")) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${appendKoreanTopicParticle(productName)} 어떤 피부 고민과 효능에 적합한가요?`,
        "ja-JP": `${productName}はどのような肌悩みやベネフィットに向いていますか？`,
        "en-US": `What skin concerns and benefits does ${productName} address?`,
        "en-GB": `What skin concerns and benefits does ${productName} address?`
      }),
      answer: createBenefitFaqAnswer(product, locale, productName, benefit, ingredient, undefined, guidance, ocrFaqContexts.benefit)
    });
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
  if ((guidance.useReviewIntentFaq || reviewSignals) && reviewSignals && !sourcePublicIntentSet.has("review")) {
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
  if ((sourceFaqIntents.includes("suitability") || recommendedSkinType || hasSpecificTargetCustomer) && benefit) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${appendKoreanTopicParticle(productName)} 어떤 고객에게 추천할 수 있나요?`,
        "ja-JP": `${productName}はどのようなお客様に向いていますか？`,
        "en-US": `Who is ${productName} best suited for?`,
        "en-GB": `Who is ${productName} best suited for?`
      }),
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
      answer: createTextureFaqAnswer(locale, productName, textureFinish, benefit, reviewSignals)
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
  if (guidance.useEvidenceBackedClaims && (evidence || reviewSignals) && !sourcePublicIntentSet.has("evidence") && hasExternalAuthorityEvidenceSignal(product, evidence)) {
    faq.push({
      question: createEvidenceFaqQuestion(locale, productName, evidence),
      answer: createEvidenceFaqAnswer(locale, evidence, reviewSignals)
    });
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

  return rankFaqCandidatesForCitation(
    [
      ...sourceFaq.map((item) => ({ item, sourceBacked: true })),
      ...faq.map((item) => ({ item, sourceBacked: false }))
    ],
    product,
    locale,
    productName,
    faqLimit
  );
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
    return 12;
  }
  if (coverageCount >= 5 || input.sourceFaq.length >= 6 || sourceIntentCoverage >= 4) {
    return 10;
  }
  return 6;
}

function rankFaqCandidatesForCitation(
  candidates: Array<{ item: PdpGeoFaqItem; sourceBacked: boolean }>,
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  productName: string,
  limit: number
): PdpGeoFaqItem[] {
  const normalized = candidates
    .map((candidate, index) => {
      const item = normalizeGeneratedFaqItem(candidate.item, locale);
      if (!item
        || isLowQualityFaqItem(item)
        || hasProductSpecificFaqQualityIssue(item, product)
        || !isFaqQuestionAnswerAligned(item, product, locale, candidate.sourceBacked)) {
        return undefined;
      }
      return {
        item,
        sourceBacked: candidate.sourceBacked,
        index,
        score: scoreFaqCandidateForCitation(item, product, locale, productName, candidate.sourceBacked)
      };
    })
    .filter((value): value is { item: PdpGeoFaqItem; sourceBacked: boolean; index: number; score: number } => Boolean(value))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const seen = new Set<string>();
  const results: PdpGeoFaqItem[] = [];
  for (const candidate of normalized) {
    const key = normalizeFaqQuestionKey(candidate.item.question);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(candidate.item);
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function isLowQualityFaqItem(item: PdpGeoFaqItem): boolean {
  const combined = `${item.question} ${item.answer}`;
  return isLowQualityPublicEvidenceText(combined)
    || hasFaqCitationNoise(combined)
    || item.answer.length < 12
    || item.answer.length > 620
    || isQuestionLikeText(item.answer)
    || isBrokenMarketingFragment(item.answer);
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
  return /(?:NEW\s*\||\|\s*(?:자음생|cream|serum|Sulwhasoo)|\bSulwhasoo\b|상품\s*상세\s*테스트|확인\s*키워드|결과\s*성분\s*설명입니다|성분\s*설명입니다|확인\s*근거를\s*정리|확인\s*근거에는|정보를\s*정리합니다)/i.test(text);
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
  if (/(?:리뷰|고객|후기|review|customer|rating)/i.test(combined)) {
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

function normalizeFaqQuestionKey(question: string): string {
  return cleanSignal(question)
    .toLocaleLowerCase()
    .replace(/[?？!.。！？]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function selectSourceFaqForPublicUse(faq: PdpGeoFaqItem[], locale: PdpGeoLocale, productName: string): PdpGeoFaqItem[] {
  return faq.flatMap((item) => {
    const question = normalizePublicFactText(item.question);
    const answer = normalizePublicFactText(item.answer);
    if (!question || !answer || !isUsefulSourceFaqQuestion(question, answer, locale, productName) || !isUsefulSourceFaqAnswer(answer, locale)) {
      return [];
    }
    return [{ question, answer: locale === "ko-KR" ? answer : trimTrailingSentencePunctuation(answer) }];
  }).slice(0, 12);
}

function isUsefulSourceFaqQuestion(value: string, answer: string, locale: PdpGeoLocale, productName: string): boolean {
  const text = cleanSignal(value);
  if (text.length < 6 || text.length > 180 || isSectionHeadingFaqQuestion(text) || isBrokenMarketingFragment(text)) {
    return false;
  }
  const productSpecific = containsEntityToken(`${text} ${answer}`, productName);
  if ((locale === "en-US" || locale === "en-GB") && !productSpecific && text.length < 28 && answer.length < 80) {
    return false;
  }
  return !/(?:GEO|RAG|schema optimization|citation-ready|field contract|OCR|image caption)/i.test(text);
}

function isUsefulSourceFaqAnswer(value: string, _locale: PdpGeoLocale): boolean {
  const text = cleanSignal(value);
  if (text.length < 12 || text.length > 520 || isQuestionLikeText(text) || isBrokenMarketingFragment(text) || isNonCitationEvidenceArtifact(text) || isLowQualityPublicEvidenceText(text)) {
    return false;
  }
  return !/(?:GEO|RAG|schema optimization|citation-ready|field contract|OCR|image caption|product shot|pack shot)/i.test(text);
}

function createTextureFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  textureFinish: string,
  benefit: string | undefined,
  reviewSignals: string
): string {
  if (locale === "ko-KR") {
    const texturePhrase = /(?:사용감|마무리|제형|텍스처)$/u.test(textureFinish)
      ? textureFinish
      : `${textureFinish} 사용감`;
    return compactSentence([
      `${appendKoreanTopicParticle(productName)} ${texturePhrase}이 강조된 제품입니다`,
      benefit ? `${appendKoreanObjectParticle(benefit)} 함께 고려할 수 있습니다` : undefined,
      reviewSignals ? `고객 리뷰에서는 ${reviewSignals} 같은 표현도 확인됩니다` : undefined
    ]);
  }
  return compactSentence([
    `${productName} has a ${textureFinish} texture or finish`,
    benefit ? `${capitalizeFirst(benefit)} is the main benefit to compare with that texture` : undefined,
    reviewSignals ? `Customer reviews also mention ${reviewSignals}` : undefined
  ]);
}

function createRoutineSynergyFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  routineSynergy: string,
  optimizedUsage: string | undefined,
  ingredient: string | undefined
): string {
  if (locale === "ko-KR") {
    return compactSentence([
      `${appendKoreanTopicParticle(productName)} ${routineSynergy}`,
      optimizedUsage ? `사용법은 ${trimTrailingSentencePunctuation(optimizedUsage)}입니다` : undefined,
      ingredient ? `${ingredient} 성분/기술 맥락과 함께 루틴 선택 기준을 제공합니다` : undefined
    ]);
  }
  return compactSentence([
    `${productName} fits ${routineSynergy}`,
    optimizedUsage ? createEnglishUsageActionSentence(optimizedUsage) : undefined,
    ingredient ? `${ingredient} ${englishSubjectVerb(ingredient, "helps", "help")} shoppers compare the formula within the routine` : undefined
  ]);
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
    return compactSentence(dedupeGeneratedSentenceParts([
      `${appendKoreanTopicParticle(productName)} ${targetClause ? `${targetClause} ` : ""}${appendKoreanObjectParticle(benefitPhrase)} 돕는 ${productType}입니다`,
      ingredient ? createKoreanIngredientFaqSupportSentence(ingredient, benefitPhrase) : undefined,
      guidance.useEvidenceBackedClaims && evidence ? localizedEvidenceContext(locale, evidence) : undefined,
      ocrContext
    ]));
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
        ? `${productName}에는 ${ingredientSubject} 포함되어 있으며, ${appendKoreanObjectParticle(benefitPhrase ?? benefit)} 돕는 핵심 성분/기술입니다`
        : `${productName}에는 ${ingredientSubject} 포함되어 있으며, 제품 포뮬러를 구분하는 핵심 성분/기술입니다`,
      ocrContext
    ]);
  }

  return compactSentence([
    fallback(locale, {
      "ko-KR": `${productName}의 주요 성분/기술은 ${ingredient}입니다`,
      "ja-JP": `${productName}の主な成分・技術は${ingredient}です`,
      "en-US": benefit
        ? `${productName} highlights ${ingredient} as a key formula element for ${benefit}`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`,
      "en-GB": benefit
        ? `${productName} highlights ${ingredient} as a key formula element for ${benefit}`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`
    }),
    benefit ? localizedIngredientChoiceContext(locale, benefit, ingredient) : undefined,
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
    return compactSentence([
      `고객 리뷰에서는 ${reviewSignals} 같은 표현이 반복되어 ${productName}의 사용감을 판단하는 데 도움이 됩니다`,
      benefit ? `${appendKoreanObjectParticle(benefit)} 기대하는 고객은 리뷰의 사용감과 만족도 표현을 함께 참고할 수 있습니다` : undefined,
      evidence ? localizedEvidenceContext(locale, evidence) : undefined
    ]);
  }

  return compactSentence([
    fallback(locale, {
      "ko-KR": `고객 리뷰에서는 ${reviewSignals} 표현으로 ${productName}을 설명합니다`,
      "ja-JP": `レビューでは${reviewSignals}という表現で${productName}が説明されています`,
      "en-US": `Customer reviews describe ${productName} with use-feel and satisfaction language such as ${reviewSignals}`,
      "en-GB": `Customer reviews describe ${productName} with use-feel and satisfaction language such as ${reviewSignals}`
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
  ingredient: string | undefined,
  evidence: string | undefined,
  _ocrContext?: string
): string {
  if (locale === "ko-KR") {
    const targetClause = formatKoreanFaqTargetClause(product);
    const benefitPhrase = formatKoreanFaqBenefitPhrase(product, locale, benefit);
    const productType = formatKoreanFaqProductType(product);
    return compactSentence(dedupeGeneratedSentenceParts([
      `${appendKoreanTopicParticle(productName)} ${targetClause ? `${targetClause} ` : ""}${appendKoreanObjectParticle(benefitPhrase)} 비교할 때 선택하기 좋은 ${productType}입니다`,
      localizedSuitabilityBenefitContext(product, locale, benefitPhrase, ingredient),
      evidence ? localizedSuitabilityEvidenceContext(product, locale, evidence) : undefined
    ]));
  }

  return compactSentence(dedupeGeneratedSentenceParts([
    fallback(locale, {
      "ko-KR": `${appendKoreanTopicParticle(productName)} ${inferTargetCustomer(product, locale)}에게 설명하기 좋은 제품입니다`,
      "ja-JP": `${productName}は${inferTargetCustomer(product, locale)}に説明しやすい商品です`,
      "en-US": `${productName} is framed for ${inferTargetCustomer(product, locale)}`,
      "en-GB": `${productName} is framed for ${inferTargetCustomer(product, locale)}`
    }),
    localizedSuitabilityBenefitContext(product, locale, benefit, ingredient),
    evidence ? localizedSuitabilityEvidenceContext(product, locale, evidence) : undefined
  ]));
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
      return sample
        ? `${sample.replace(/\s*고객$/u, "")} 대상 시험/평가에서 ${metricBody}가 제시되어 효능 판단을 보완합니다`
        : `${metricBody} 결과를 함께 참고할 수 있습니다`;
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
        ? `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(benefit)} ${ingredient} 성분/기술과 함께 제시합니다`
        : `${appendKoreanTopicParticle(productName)} ${appendKoreanObjectParticle(benefit)} 핵심 효능/장점으로 제시합니다`;
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

function normalizeGeneratedFaqItem(item: PdpGeoFaqItem, locale: PdpGeoLocale): PdpGeoFaqItem | undefined {
  const question = normalizePublicFactText(item.question);
  const answer = normalizePublicFactText(item.answer);
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
  optimizedUsageSteps: string[];
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
  const usageInstructions = input.optimizedUsageSteps.length > 0 ? input.optimizedUsageSteps : selectUsageInstructions(input.product);
  const reviewItems = selectReviewItems(input.product, input.locale);
  const schemaImages = selectSchemaImages(input.product, input.productName, input.sourceUrl);
  const offer = createOfferSchema(input.product, input.locale, input.market, input.sourceUrl);
  const aggregateRating = createAggregateRatingSchema(input.product);
  const rawCategory = sanitizeCategory(input.product.category) ?? inferProductType(input.product);
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
        input.targets.includes("HowTo") && usageInstructions.length > 0 ? { "@id": howToId } : undefined
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
      additionalProperty: createAdditionalProperties(input.product, usageInstructions, input.locale),
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

  if (input.targets.includes("HowTo") && usageInstructions.length > 0) {
    graph.push(cleanJson({
      "@type": "HowTo",
      "@id": howToId,
      name: fallback(input.locale, {
        "ko-KR": `${input.productName} 사용 방법`,
        "ja-JP": `${input.productName}の使い方`,
        "en-US": `How to use ${input.productName}`,
        "en-GB": `How to use ${input.productName}`
      }),
      inLanguage: input.locale,
      isPartOf: input.targets.includes("WebPage") ? { "@id": webpageId } : undefined,
      about: { "@id": productId },
      step: usageInstructions.map((usage, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: createHowToStepName(usage, input.locale, index),
        text: usage
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

function createAdditionalProperties(product: PdpProductSignal, usageInstructions: string[], locale: PdpGeoLocale): JsonObject[] {
  const claimSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const ingredientEffectDetail = createIngredientEffectDetailProperty(product, locale, claimSentences[0]);
  const reviewUseFeelContext = hasPublicReviewEvidence(product, locale) ? createReviewUseFeelProperty(product, locale) : undefined;
  const entries: Array<[string, string | undefined]> = [
    ["Target customer", createTargetCustomerProperty(product, locale)],
    ["Recommended skin type", inferRecommendedSkinType(product, locale)],
    ["Key benefit", selectPublicPrimaryBenefit(product, locale)],
    ["Key efficacy", createKeyEfficacyProperty(product, locale)],
    ["Key ingredients", selectKeyIngredients(product, 5).join(", ")],
    ["Key ingredients and technologies", createKeyIngredientTechnologyProperty(product, locale)],
    ["Ingredient/effect detail", formatClaimSentence(ingredientEffectDetail, locale)],
    ["Functional certification", createFunctionalCertificationProperty(product, locale)],
    ["Texture and finish", selectTextureFinishSignal(product, locale)],
    ["Brand science", createBrandScienceProperty(product, locale)],
    ["Usage", formatUsagePropertyValue(usageInstructions, locale)],
    ["Routine synergy", createRoutineSynergyProperty(product, locale)],
    ["Customer review context", formatClaimSentence(reviewUseFeelContext, locale)],
    ["Consumer satisfaction", createConsumerSatisfactionProperty(product, locale)],
    ["Reported details", createReportedDetailsProperty(product, locale)],
    ["Clinical result summary", createClinicalResultSummaryProperty(product, locale)],
    ["Variant comparison", selectVariantComparisonSignal(product, locale)],
    ["Renewal guidance", createRenewalGuidanceProperty(product, locale)],
    ["Gift suitability", createGiftSuitabilityProperty(product, locale)],
    ["Options", product.options.slice(0, 5).join(", ")]
  ];

  return entries.flatMap(([name, value]) => {
    const cleanValue = value ? sanitizeProductSchemaPropertyText(name, value, locale) : undefined;
    return cleanValue && isUsefulSchemaPropertyValue(name, cleanValue) ? [{
      "@type": "PropertyValue",
      name,
      value: cleanValue
    }] : [];
  });
}

function createKeyEfficacyProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 6);
  return benefits.length > 1 ? formatDescriptionList(benefits, locale, 6) : undefined;
}

function createTargetCustomerProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const evidenceBackedTarget = inferEvidenceBackedTargetCustomer(product, locale);
  return evidenceBackedTarget ?? inferTargetCustomer(product, locale);
}

function createKeyIngredientTechnologyProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const ingredients = selectKeyIngredients(product, 6);
  if (ingredients.length === 0) {
    return undefined;
  }
  const text = allProductEvidenceText(product);
  const hasTechnologyContext = /technology|formula|complex|capsule|peptide|retinol|derivative|active|proprietary|patent|기술|포뮬러|복합체|캡슐|펩타이드|레티놀|유도체|독자|특허/i.test(text);
  if (!hasTechnologyContext && ingredients.length < 3) {
    return undefined;
  }
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 6);
  const benefitPhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale).slice(0, 3), locale, 3);
  if (!ingredientPhrase) {
    return undefined;
  }
  if (locale === "ko-KR") {
    return benefitPhrase ? `${ingredientPhrase} 성분/기술이 ${benefitPhrase} 케어 맥락과 연결됩니다.` : `${ingredientPhrase} 성분/기술이 핵심 포뮬러 정보입니다.`;
  }
  return benefitPhrase ? `${ingredientPhrase} are highlighted with ${benefitPhrase} context.` : `${ingredientPhrase} are highlighted as formula or technology details.`;
}

function createFunctionalCertificationProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  return formatDescriptionList(selectFunctionalCertificationSignals(product, locale), locale, 3);
}

function selectFunctionalCertificationSignals(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  const evidenceText = allProductEvidenceText(product);
  const directSignals = [
    /민감\s*피부\s*사용\s*적합\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "민감 피부 사용 적합 테스트 완료" : undefined,
    /피부\s*자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "피부 자극 테스트 완료" : undefined,
    /저자극\s*테스트(?:를)?\s*완료/i.test(evidenceText) ? "저자극 테스트 완료" : undefined,
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

  return unique([...directSignals, ...sentenceSignals]).slice(0, 3);
}

function normalizeFunctionalCertificationSentence(value: string, locale: PdpGeoLocale): string | undefined {
  const text = trimTrailingSentencePunctuation(sanitizeProductSchemaText(value, locale)
    .replace(/^네,\s*/u, "")
    .replace(/\s*\.,\s*/g, ". ")
    .replace(/\s+/g, " ")
    .trim());
  if (!text || /(?:후기|리뷰|review|rating|모이스처라이징|기본\s*보습|만족도가\s*높|사용\s*중단|콜라겐\s*발현율)/i.test(text)) {
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
  return truncateAtCompleteSentence(text, 140);
}

function createBrandScienceProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const signals = selectSourceSentencesByIntent(product, researchOrTechnologyPattern(), locale, 4)
    .map((value) => normalizeBrandScienceSignal(value, locale))
    .filter((value): value is string => Boolean(value));
  return formatDescriptionList(unique(signals).slice(0, 2), locale, 2);
}

function normalizeBrandScienceSignal(value: string, locale: PdpGeoLocale): string | undefined {
  const text = trimTrailingSentencePunctuation(sanitizeProductSchemaText(value, locale)
    .replace(/\bNEW\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim());
  if (!text || isQuantifiedClinicalResultSentence(text) || isCommerceMetricArtifact(text)) {
    return undefined;
  }
  if (locale === "ko-KR") {
    const science = text.match(/(?:\d+\s*년\s*)?[^.!?。！？]{0,24}(?:인삼과학|피부과학|과학|연구)[^.!?。！？]{0,60}/)?.[0];
    const technology = text.match(/(?:진세노믹스|레티놀|펩타이드|콜라겐|사포닌|기술|포뮬러)[^.!?。！？]{0,60}/)?.[0];
    return cleanSignal(science ?? technology ?? truncateAtCompleteSentence(text, 120));
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
    const certifications = text
      .split(/\s*,\s*|[.。]\s*/)
      .map(cleanSignal)
      .filter(Boolean)
      .filter((item) => /(?:사용\s*적합|피부\s*자극|저자극|논코메도|하이포알러지|dermatolog|hypoallergenic|non[-\s]?comedogenic)/i.test(item))
      .filter((item) => !isQuantifiedClinicalResultSentence(item));
    return formatDescriptionList(unique(certifications), locale, 3) ?? "";
  }
  if (/^Brand science$/i.test(name)) {
    return truncateAtCompleteSentence(text.replace(/\bNEW\b/gi, " ").replace(/\s+/g, " "), 160);
  }
  if (/^Customer review context$/i.test(name)) {
    return truncateAtCompleteSentence(text, locale === "ko-KR" ? 180 : 220);
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
  const ingredients = selectKeyIngredients(product, 3);
  const benefits = selectPublicBenefitSignals(product, locale).slice(0, 4);
  const ingredientPhrase = formatDescriptionList(ingredients, locale, 3);
  const benefitPhrase = formatDescriptionList(benefits, locale, 4);
  const customerContext = inferTargetCustomer(product, locale);

  if (ingredientPhrase && benefitPhrase) {
    if (locale === "ko-KR") {
      return `${formatKoreanIngredientTopicPhrase(ingredientPhrase)} ${benefitPhrase} 케어를 뒷받침하며, ${customerContext}의 제품 선택 기준을 더 분명하게 합니다`;
    }
    if (locale === "ja-JP") {
      return `${ingredientPhrase}は${benefitPhrase}を支え、${customerContext}の選択基準をより明確にします`;
    }
    return `The formula uses ${ingredientPhrase} to support ${benefitPhrase}, making the source evidence a clearer selection cue for ${customerContext}.`;
  }

  const detail = first(selectIngredientDetails(product, ingredients, 1));
  if (detail) {
    return detail;
  }
  return fallbackSentence;
}

function createReportedDetailsProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const clinicalSummary = createStructuredClinicalEvidenceSummary(product, locale);
  if (clinicalSummary) {
    return clinicalSummary;
  }

  const structuredMetricDetails = selectStructuredReportedMetricDetails(product, locale, 3)
    .map((detail) => trimTrailingSentencePunctuation(detail))
    .filter((value): value is string => Boolean(value));
  const reportedDetails = selectReportedDetails(product, 3);
  const formattedDetails = unique(reportedDetails
    .map((detail) => formatReportedDetailForProperty(formatReportedDetailItem(detail, locale), locale))
    .filter((value): value is string => Boolean(value))
    .map(trimTrailingSentencePunctuation));
  const details = unique([...structuredMetricDetails, ...formattedDetails])
    .filter(hasQuantifiedReportedSignal);
  if (details.length > 0) {
    const separator = locale === "ko-KR" ? ". 또한, " : ". Also, ";
    const value = details.join(separator);
    return /[.!?。！？]$/.test(value) ? value : `${value}.`;
  }

  const fallbackEvidence = selectEvidenceSignal(product, locale);
  const formattedFallback = fallbackEvidence && isHardEvidenceSignal(fallbackEvidence)
    ? formatReportedDetailForProperty(formatReportedDetailItem(fallbackEvidence, locale), locale)
    : undefined;
  if (formattedFallback && hasQuantifiedReportedSignal(formattedFallback)) {
    return formattedFallback;
  }

  return createSimpleReportedMetricProperty(product, locale);
}

function createSimpleReportedMetricProperty(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const metric = first([
    ...product.metrics,
    ...product.effects,
    ...product.benefits
  ]
    .map((value) => trimTrailingSentencePunctuation(sanitizeProductSchemaText(value, locale)))
    .filter((value) => hasQuantifiedReportedSignal(value) && !isCommerceMetricArtifact(value) && !isQuestionLikeText(value)));
  if (!metric) {
    return undefined;
  }
  if (locale === "ko-KR") {
    return /(?:결과|개선|증가|감소|회복)/.test(metric) ? `${metric}.` : `${metric} 결과가 제시되었습니다.`;
  }
  if (locale === "ja-JP") {
    return `${metric}。`;
  }
  return /^Reported result:/i.test(metric) ? ensurePublicSentence(metric, locale) : `Reported result: ${metric}.`;
}

function createStructuredClinicalEvidenceSummary(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const semanticSummary = createSemanticClinicalEvidenceSummary(product, locale);
  if (semanticSummary) {
    return semanticSummary;
  }
  const text = allProductEvidenceText(product);
  if (locale === "ko-KR") {
    return createKoreanClinicalEvidenceSummary(text);
  }
  return undefined;
}

function createSemanticClinicalEvidenceSummary(product: PdpProductSignal, locale: PdpGeoLocale): string | undefined {
  const claims = (product.semanticFacts?.metricClaims ?? [])
    .filter((item) => hasSemanticClinicalClaimContext(item))
    .filter((item) => hasQuantifiedReportedSignal([item.label, item.value, item.unit, item.sentence, item.sourceText].filter(Boolean).join(" ")))
    .slice(0, 3);
  if (claims.length === 0) {
    return undefined;
  }

  if (locale === "ko-KR") {
    const summaries = claims
      .map(formatKoreanSemanticClinicalClaim)
      .filter((value): value is string => Boolean(value));
    const summary = summaries.length > 0 ? `${summaries.join(". 또한, ")}.`.replace(/결과\s+결과/g, "결과") : undefined;
    return summary && isPublicSemanticClinicalSummary(summary) ? summary : undefined;
  }

  const formatted = claims
    .map((claim) => formatSemanticMetricClaim(claim, locale))
    .filter((value): value is string => Boolean(value));
  return formatted.length > 0 ? formatted.join(" ") : undefined;
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
  const method = cleanSignal(claim.method ?? "") || "시험/평가";
  const sample = cleanSignal(claim.sample ?? "");
  const period = cleanSignal(claim.period ?? claim.timing ?? "");
  const label = cleanSignal(claim.label ?? claim.subject ?? claim.metric ?? "");
  const value = cleanSignal([claim.value, claim.unit].filter(Boolean).join(""));
  const sourceSentence = trimTrailingSentencePunctuation(cleanSignal(claim.sentence ?? claim.sourceText ?? ""));
  const result = label && value
    ? `${label} ${value}`
    : sourceSentence || label || value;
  const context = [method, sample, period].filter(Boolean).join(", ");
  if (!result || !hasQuantifiedReportedSignal(result)) {
    return undefined;
  }
  return context
    ? `${context} 기준 ${result} 결과가 제시되었습니다`
    : `${result} 결과가 제시되었습니다`;
}

function hasSemanticClinicalClaimContext(claim: PdpSemanticMetricClaim): boolean {
  const text = cleanSignal([claim.method, claim.sample, claim.period, claim.timing, claim.sentence, claim.sourceText].filter(Boolean).join(" "));
  const hasMethod = /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)/i.test(text);
  const hasPopulation = /(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|participants?|subjects?)/i.test(text);
  const hasPeriod = /(?:\d+(?:\.\d+)?\s*(?:주|일|시간|weeks?|days?|hours?)|사용\s*중단\s*1\s*주\s*후|after\s+\d|daily\s+use)/i.test(text);
  return hasMethod && (hasPopulation || hasPeriod);
}

function createKoreanClinicalEvidenceSummary(value: string): string | undefined {
  const text = cleanSignal(value);
  if (!isQuantifiedClinicalResultSentence(text)) {
    return undefined;
  }

  const sample = text.match(/(?:시험\s*대상|대상)\s*[:：]?\s*(?:만\s*)?\d{2}\s*[-~–—]\s*\d{2}\s*세\s*(?:여성|남성|성인|대상자|사용자|참여자)?\s*\d+\s*명/)?.[0]
    ?? text.match(/(?:만\s*)?\d{2}\s*[-~–—]\s*\d{2}\s*세\s*(?:여성|남성|성인|대상자|사용자|참여자)?\s*\d+\s*명/)?.[0]
    ?? text.match(/\d+\s*명\s*(?:대상|참여|사용자|여성|남성)/)?.[0];
  const period = text.match(/(?:시험\s*기간|기간)\s*[:：]?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/)?.[0]
    ?? text.match(/\d+(?:\.\d+)?\s*주\s*(?:사용|후|동안)|사용\s*중단\s*1\s*주\s*후/)?.[0];
  const method = text.match(/(?:인체\s*적용\s*시험|자가\s*평가|소비자\s*평가|in\s*vitro|ex\s*vivo)/i)?.[0];

  const wrinkleMetrics = extractKoreanWrinkleMetricGroups(text);
  const genericMetrics = wrinkleMetrics.length > 0 ? [] : extractKoreanEvidenceMetricClauses(text).slice(0, 4);
  const metricPhrase = wrinkleMetrics.length > 0 ? wrinkleMetrics.join(", ") : genericMetrics.join(", ");
  if (!metricPhrase || !/%/.test(metricPhrase)) {
    return undefined;
  }

  const context = [method, sample, period].filter(Boolean).join(", ");
  const summary = context
    ? `${context} 기준 ${metricPhrase} 결과가 제시되었습니다.`
    : `${metricPhrase} 결과가 제시되었습니다.`;
  return summary.replace(/결과\s+결과/g, "결과");
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
  const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "product", locale);

  if (!reviewPhrase || !outcomePhrase) {
    return undefined;
  }

  return createEnglishReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase);
}

function createKoreanReviewUseFeelProperty(product: PdpProductSignal): string | undefined {
  const locale: PdpGeoLocale = "ko-KR";
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
  const outcomePhrase = formatDescriptionList(selectPublicBenefitSignals(product, locale), locale, 4);
  const productType = localizeProductTypeForLocale(sanitizeCategory(product.category) ?? inferProductType(product) ?? "제품", locale);

  if (!reviewPhrase || !outcomePhrase) {
    return undefined;
  }

  return createKoreanReviewUseFeelSentence(productType, reviewPhrase, outcomePhrase);
}

function sanitizeProductSchemaText(value: string, locale: PdpGeoLocale): string {
  return normalizePublicFactText(value)
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
    .replace(/\bKEY INGREDIENTS\s*:\s*/g, "")
    .replace(/\bKEY INGREDIENTS\s+details?\s+mention\b/g, "Ingredient details mention")
    .replace(/\b(?:and|with)\s+KEY INGREDIENTS\b/g, "")
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\\[rn]/g, " ")
    .replace(/:([^\s])/g, ": $1")
    .replace(/([a-z])(?=[A-Z][a-z]{2,}\b)/g, "$1. ")
    .replace(/([.!?。！？])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
      && hasQuantifiedReportedSignal(value)
      && !isCommerceMetricArtifact(value);
  }
  if (name === "Key ingredients") {
    return value.split(",").every((item) => {
      const token = cleanSignal(item);
      return token.length > 0 && token.length <= 80 && !/[.。！？?]/.test(token) && !/(설계|동일|자극|고객님|리뉴얼 전 제품)/.test(token);
    });
  }
  if (name === "Reported details") {
    return !isQuestionLikeText(value) && !isNonCitationEvidenceArtifact(value);
  }
  return true;
}

function hasCompleteReportedDetailContext(value: string): boolean {
  const text = cleanSignal(value);
  if (!isQuantifiedClinicalResultSentence(text)) {
    return false;
  }
  const hasPopulation = /(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|participants?|subjects?)/i.test(text);
  const hasPeriod = /(?:\d+(?:\.\d+)?\s*(?:주|일|시간|weeks?|days?|hours?)|시험\s*기간|after\s+\d|사용\s*중단\s*1\s*주\s*후|daily\s+use)/i.test(text);
  const hasMethod = /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)/i.test(text);
  return hasPopulation && hasPeriod && hasMethod;
}

function createPositiveNotes(product: PdpProductSignal, locale: PdpGeoLocale): JsonObject | undefined {
  const notes = dedupePublicListValues([
    ...selectPublicBenefitSignals(product, locale),
    ...selectGroundedExpressionPhrases(product, locale, 6)
  ].filter((value): value is string => Boolean(value)).filter(isUsefulPublicListValue)).slice(0, 6);
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

  const items = entries.map(([key, value], index) => `
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
      reason: "Structured the description for generative engines: target customer, benefit, ingredient/technology, usage context, review keyword, and evidence signal."
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
      reason: "Reframed FAQ around GEO question intent, customer review signals, product benefit, ingredient/technology, usage context, and evidence signals so generated answers stay grounded and reusable."
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
  const document = documents.find((item) => item.name === pdpGeoGeneratorRagManifest.documents.localeTerminologyMap || /terminology/i.test(item.name));
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
  const text = trimTrailingSentencePunctuation(parts.filter(Boolean).join(". ").replace(/\.+/g, ".").trim());
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
  if (isKoreanCompleteSentence(cleanEvidence)) {
    return cleanEvidence;
  }
  const metrics = cleanEvidence
    .replace(/(?:확인\s*지표|확인\s*근거|측정\s*결과|평가\s*지표)\s*:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*결과$/u, "");
  return `${metrics} 결과입니다`;
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
  return `${head}${hasKoreanBatchim(tail) ? "과" : "와"} ${tail}`;
}

function formatKoreanFaqBenefitPhrase(product: PdpProductSignal, locale: PdpGeoLocale, fallbackBenefit: string): string {
  const sourceCandidates = selectKoreanFaqBenefitSignals(product);
  const candidates = sourceCandidates.length ? sourceCandidates : selectPublicBenefitSignals(product, locale).slice(0, 3);
  return formatKoreanCarePhraseForFaq(formatDescriptionList(candidates, locale, 3) ?? fallbackBenefit);
}

function selectKoreanFaqBenefitSignals(product: PdpProductSignal): string[] {
  const sourceValues = [
    ...(product.semanticFacts?.benefits ?? []),
    ...(product.semanticFacts?.effects ?? []),
    ...product.benefits,
    ...product.effects
  ];
  return dedupePublicListValues([
    ...sourceValues,
    ...sourceValues.flatMap(extractBenefitSignalCandidates)
  ]
    .map(normalizeBenefitSignal)
    .filter((value): value is string => Boolean(value))
    .filter((value) => /[가-힣]/.test(value) && value.length <= 42 && isUsefulBenefitSignal(value) && isUsefulPublicListValue(value))
    .filter((value) => !isAbstractKoreanCareMarketingFragment(value)))
    .slice(0, 3);
}

function isAbstractKoreanCareMarketingFragment(value: string): boolean {
  const text = cleanSignal(value);
  if (!text || !/[가-힣]/.test(text)) {
    return false;
  }
  const tokens = text
    .split(/\s*(?:,|，|\/|·|와|과|및|또는)\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^(?:자생력|고밀도|피부|정수|영양감|산뜻한|리치한|NEW)$/i.test(token));
}

function formatKoreanCarePhraseForFaq(value: string): string {
  return cleanSignal(value)
    .replace(/\s*효능\s*\/\s*케어/g, " 효능/케어")
    .replace(/\s+케어\s+케어/g, " 케어")
    .replace(/피부\s+장벽/g, "피부장벽")
    .trim();
}

function formatKoreanFaqTargetClause(product: PdpProductSignal): string | undefined {
  const target = cleanSignal(createTargetCustomerProperty(product, "ko-KR") ?? "");
  if (!target) {
    return undefined;
  }

  const normalized = target
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
  const rawProductType = sanitizeCategory(product.category) ?? inferProductType(product) ?? "제품";
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
  return `${formatKoreanListForSentence(value)} 성분/기술이`;
}

function formatKoreanIngredientTopicPhrase(value: string): string {
  const text = formatKoreanListForSentence(value);
  if (text.includes(",") || /[A-Za-z]/.test(text)) {
    return `${text} 성분/기술은`;
  }
  return appendKoreanTopicParticle(text);
}

function formatKoreanIngredientObjectPhrase(value: string): string {
  const text = formatKoreanListForSentence(value);
  if (text.includes(",") || /[A-Za-z]/.test(text)) {
    return `${text} 성분/기술을`;
  }
  return appendKoreanObjectParticle(text);
}

function appendKoreanTopicParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "은" : "는"}`;
}

function appendKoreanObjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "을" : "를"}`;
}

function appendKoreanInstrumentParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "으로" : "로"}`;
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
