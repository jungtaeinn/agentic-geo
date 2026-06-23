import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoContentSections,
  PdpGeoEvidence,
  PdpGeoFaqItem,
  PdpGeoGenerationHints,
  PdpGeoLocale,
  PdpGeoRecommendation,
  PdpGeoRetrievedChunk,
  PdpGeoReviewItem,
  PdpGeoSchemaMarkup,
  PdpGeoSchemaTarget,
  PdpGeoTerminologyDiagnostics,
  PdpProductSignal
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
  const guidance = createGeoOptimizationGuidance(input.ragChunks, input.ragDocuments);
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
  const optimizedUsageSteps = createOptimizedUsageSteps(input.product, productName, input.locale, guidance);
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
    { field: "content.description", source: "rag", value: `Description follows target customer + benefits + ingredients/technology + routine fit + review keywords + evidence. ${input.ragChunks.length} RAG chunks selected.` }
  );
  if (guidance.sources.length > 0) {
    evidence.push({
      field: "rag.geoOptimizationGuidance",
      source: "rag",
      value: `Reconstructed HowTo, FAQ, and benefit content with GEO guidance from: ${guidance.sources.join(", ")}`
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
    html: createAccordionHtml(sections, input.locale),
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
  return product.name.trim();
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
        `${productName}은 ${context.targetCustomer}을 위한 ${context.productType}으로, ${benefit} 효능을 중심으로 설명됩니다`,
        createProductIngredientDescription(locale, context),
        createProductUsageDescription(locale, context.usage),
        createLocalizedReviewDescription(locale, context),
        evidence ? createProductEvidenceDescription(locale, evidence) : undefined
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
        `${productName} 상품 페이지는 ${context.targetCustomer}이 ${context.productType}을 비교할 때 필요한 효능, 성분, 사용법, 고객 리뷰 근거를 상세히 정리합니다`,
        context.benefitPhrase ? `효능 영역에서는 ${context.benefitPhrase}를 다룹니다` : undefined,
        context.ingredientPhrase ? `성분 영역은 ${context.ingredientPhrase}${context.ingredientDetail ? ` 등 주요 성분 설명` : ""}을 중심으로 구성됩니다` : undefined,
        context.reviewPhrase ? `리뷰 기반 표현으로는 ${context.reviewPhrase}가 함께 노출됩니다` : undefined,
        context.reportedDetail ? createWebPageEvidenceDescription(locale, context.reportedDetail) : undefined
      ]);
    case "ja-JP":
      return compactSentence([
        `${productName}の商品ページは${context.targetCustomer}が${context.productType}を検討するために、ベネフィット、成分、使い方、レビュー根拠を整理します`,
        context.benefitPhrase ? `ベネフィットとして${context.benefitPhrase}を扱います` : undefined,
        context.ingredientPhrase ? `成分情報では${context.ingredientPhrase}${context.ingredientDetail ? `などの主要成分説明` : ""}を確認できます` : undefined,
        context.reviewPhrase ? `レビュー由来の表現として${context.reviewPhrase}も示します` : undefined,
        context.reportedDetail ? `確認できる結果・情報として${truncate(context.reportedDetail, 420)}を参照できます` : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        `This ${productName} product page helps ${context.targetCustomer} evaluate the ${lowercaseEnglishProductType(context.productType)} through skin-care benefits, key actives, usage routine, texture, and customer reviews`,
        context.benefitPhrase ? `It covers benefits such as ${context.benefitPhrase}` : undefined,
        context.ingredientPhrase ? `It surfaces key ingredients and technologies including ${context.ingredientPhrase}${context.ingredientDetail ? `, with formula details such as ${context.ingredientDetail}` : ""}` : undefined,
        context.reviewPhrase ? `It also reflects customer review language such as ${context.reviewPhrase}` : undefined,
        context.reportedDetail ? createWebPageEvidenceDescription(locale, context.reportedDetail) : undefined
      ]);
  }
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
  const reviewKeywords = selectPublicReviewKeywords(product, locale).slice(0, 5);
  const representativeReviews = selectRepresentativeReviewPhrases(product, locale, 2);
  const sourceBackedSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 5);
  const reportedDetails = selectReportedDetails(product, 2);

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
    reportedDetail: first(reportedDetails) ?? (product.description && benefits.length === 0 ? normalizePublicEvidenceText(product.description, locale) : undefined)
  };
}

function createProductIngredientDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (!context.ingredientPhrase) {
    return undefined;
  }

  switch (locale) {
    case "ko-KR":
      return context.ingredientDetail
        ? createKoreanIngredientDetailDescription(context.ingredientPhrase, context.ingredientDetail)
        : `주요 성분/기술은 ${context.ingredientPhrase}입니다`;
    case "ja-JP":
      return context.ingredientDetail
        ? `主な成分・技術は${context.ingredientPhrase}で、成分説明は${context.ingredientDetail}に焦点を当てています`
        : `主な成分・技術は${context.ingredientPhrase}です`;
    case "en-GB":
    case "en-US":
    default:
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

  return fallback(locale, {
    "ko-KR": `사용법은 ${usageContext}로 요약됩니다`,
    "ja-JP": `使い方は${usageContext}として整理できます`,
    "en-US": usageContext,
    "en-GB": usageContext
  });
}

function createProductEvidenceDescription(locale: PdpGeoLocale, evidence: string): string {
  const cleanEvidence = trimTrailingSentencePunctuation(truncateAtCompleteSentence(evidence, 420));
  const assessment = cleanEvidence.match(/^In a ([^,]+),\s*(.+)$/i);

  if (assessment) {
    const context = assessment[1];
    const result = lowercaseFirst(assessment[2] ?? "");
    switch (locale) {
      case "ko-KR":
        return `확인된 결과는 ${context} 기반이며, ${result}`;
      case "ja-JP":
        return `確認できる結果は${context}に基づき、${result}`;
      case "en-GB":
      case "en-US":
      default:
        return `Reported results come from a ${context}, where ${result}`;
    }
  }

  if (locale === "ko-KR") {
    const evidenceSentence = createKoreanEvidenceContentSentence(cleanEvidence);
    return isKoreanCompleteSentence(evidenceSentence)
      ? evidenceSentence
      : `상품 정보는 ${evidenceSentence}를 주요 내용으로 다룹니다`;
  }

  return fallback(locale, {
    "ko-KR": `확인된 상품 정보는 ${cleanEvidence}입니다`,
    "ja-JP": `確認できる商品情報は${cleanEvidence}です`,
    "en-US": `Product details add ${cleanEvidence} to the formula, skin-care benefit, and comparison story`,
    "en-GB": `Product details add ${cleanEvidence} to the formula, skin-care benefit, and comparison story`
  });
}

function createWebPageEvidenceDescription(locale: PdpGeoLocale, evidence: string): string {
  const cleanEvidence = trimTrailingSentencePunctuation(truncateAtCompleteSentence(evidence, 420));
  if (locale === "ko-KR") {
    const evidenceSentence = createKoreanEvidenceContentSentence(cleanEvidence);
    return isKoreanCompleteSentence(evidenceSentence)
      ? evidenceSentence
      : `상품 정보는 ${evidenceSentence}를 주요 내용으로 다룹니다`;
  }
  return fallback(locale, {
    "ko-KR": `확인된 결과/정보로 ${cleanEvidence}를 참고할 수 있습니다`,
    "ja-JP": `確認できる結果・情報として${cleanEvidence}を参照できます`,
    "en-US": `Product details pair ${cleanEvidence} with key ingredients, visible benefits, texture, comfort, and routine fit`,
    "en-GB": `Product details pair ${cleanEvidence} with key ingredients, visible benefits, texture, comfort, and routine fit`
  });
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
          ? `고객 리뷰에서는 ${context.reviewPhrase} 같은 표현이 확인되어 사용감과 케어 체감을 보완합니다`
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
    "ko-KR": `고객 리뷰에서는 ${context.reviewPhrase} 같은 표현이 확인되어 사용감과 케어 체감을 보완합니다`,
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
      [/cream|크림/i, "크림"],
      [/serum|세럼|앰플|에센스/i, "세럼"],
      [/toner|토너|스킨/i, "토너"],
      [/cleanser|클렌저|폼/i, "클렌저"],
      [/mask|마스크/i, "마스크"]
    ],
    "ja-JP": [
      [/cream|クリーム/i, "クリーム"],
      [/serum|美容液|セラム/i, "美容液"],
      [/toner|化粧水/i, "化粧水"],
      [/cleanser|洗顔|クレンザー/i, "クレンザー"],
      [/mask|マスク/i, "マスク"]
    ],
    "en-US": [
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ],
    "en-GB": [
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

function selectPublicPrimaryBenefit(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[] = []): string | undefined {
  return first(selectPublicBenefitSignals(product, locale, localizedTerms));
}

function selectPublicBenefitSignals(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[] = []): string[] {
  return unique([
    ...selectBenefitSignals(product),
    ...localizedTerms.filter(isUsefulBenefitSignal)
  ]
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isUsefulPublicListValue))
    .slice(0, 10);
}

function selectBenefitSignals(product: PdpProductSignal): string[] {
  return unique([
    ...product.benefits.flatMap(extractBenefitSignalCandidates),
    ...product.effects.flatMap(extractBenefitSignalCandidates),
    ...[product.description].filter((value): value is string => Boolean(value)).flatMap(extractBenefitSignalCandidates),
    ...product.sourceTexts.slice(0, 30).flatMap(extractBenefitSignalCandidates)
  ].map(normalizeBenefitSignal).filter((value): value is string => Boolean(value)).filter(isUsefulBenefitSignal)).slice(0, 10);
}

function selectKeyIngredients(product: PdpProductSignal, limit: number): string[] {
  const haystack = product.ingredients.join(" ");
  const detected = [
    /dermaon/i.test(haystack) ? "DermaON" : undefined,
    /korean ginseng actives|ginsenomics/i.test(haystack) ? "Korean Ginseng Actives (Ginsenomics)" : undefined,
    /ginseng peptide/i.test(haystack) ? "Ginseng Peptide" : undefined,
    /retinol/i.test(haystack) ? "Retinol-infused capsules" : undefined,
    /niacinamide/i.test(haystack) ? "Niacinamide" : undefined,
    /hyaluronic|sodium hyaluronate/i.test(haystack) ? "Hyaluronic Acid" : undefined,
    /zinc/i.test(haystack) ? "Zinc" : undefined,
    /ceramide/i.test(haystack) ? "Ceramide" : undefined,
    /압축\s*히알루론산/i.test(haystack) ? "압축 히알루론산" : undefined,
    /고밀도\s*세라마이드\s*캡슐/i.test(haystack) ? "고밀도 세라마이드 캡슐" : undefined,
    /링커\s*세라마이드/i.test(haystack) ? "링커 세라마이드" : undefined,
    /세라마이드/i.test(haystack) ? "세라마이드" : undefined,
    /히알루론산|하이알루론산/i.test(haystack) ? "히알루론산" : undefined,
    /징크/i.test(haystack) ? "징크" : undefined,
    /나이아신아마이드/i.test(haystack) ? "나이아신아마이드" : undefined,
    /판테놀/i.test(haystack) ? "판테놀" : undefined
  ].filter((value): value is string => Boolean(value));
  const normalized = product.ingredients
    .flatMap(splitIngredientSignal)
    .map(normalizeIngredientSignal)
    .filter((value): value is string => Boolean(value));

  return dedupeIngredientSignals([...detected, ...normalized]).slice(0, limit);
}

function dedupeIngredientSignals(values: string[]): string[] {
  const uniqueValues = unique(values);
  const hasRetinolCapsule = uniqueValues.some((value) => /retinol-infused capsules/i.test(value));
  const hasDenseCeramideCapsule = uniqueValues.some((value) => /고밀도\s*세라마이드\s*캡슐/i.test(value));
  const hasCompressedHyaluronic = uniqueValues.some((value) => /압축\s*히알루론산/i.test(value));

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
    return true;
  });
}

function selectIngredientDetails(product: PdpProductSignal, normalizedIngredients: string[], limit: number): string[] {
  const ingredientNames = normalizedIngredients.map((value) => value.toLowerCase());
  return unique(product.ingredients
    .map(stripSourceSectionLabel)
    .map(normalizeIngredientDetail)
    .filter((value): value is string => Boolean(value))
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
  const text = cleanSignal(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();

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
  const text = value
    .replace(/\s*-\s*/g, ": ")
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
  const instructions = product.usage
    .map(normalizeUsageInstruction)
    .filter(isUsageInstruction)
    .sort((a, b) => b.length - a.length);
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

function selectReviewKeywords(product: PdpProductSignal): string[] {
  return unique(product.reviews.keywords
    .map(normalizeReviewKeyword)
    .filter((value): value is string => Boolean(value))
    .filter(isReviewKeyword)).slice(0, 8);
}

function selectPublicReviewKeywords(product: PdpProductSignal, locale: PdpGeoLocale): string[] {
  return unique(selectReviewKeywords(product)
    .map((value) => localizePublicReviewKeyword(value, locale))
    .filter((value): value is string => Boolean(value))
    .filter(isUsefulPublicListValue))
    .slice(0, 8);
}

function normalizeReviewKeyword(value: string): string | undefined {
  const normalized = cleanSignal(value).replace(/\.$/, "");
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
  const normalized = cleanSignal(value)
    .replace(/[,.]$/g, "")
    .trim();
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

function normalizePublicReviewBody(value: string, locale: PdpGeoLocale): string {
  const normalized = cleanSignal(value)
    .replace(/\\[rn]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, "$1 ")
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

function selectRepresentativeReviewPhrases(product: PdpProductSignal, locale: PdpGeoLocale, limit: number): string[] {
  return unique(product.reviews.items
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
  if (/^(review|reviews|rating|ratings|star|stars|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }
  return /[가-힣ぁ-んァ-ン]/.test(normalized)
    || normalized.split(/\s+/).length >= 5
    || /absorbs?|smooth|moist|firm|elastic|plump|texture|glow|lightweight|rich|촉촉|흡수|탄력|피부결|保湿|うるおい|ハリ|なじみ/i.test(normalized);
}

function selectEvidenceSignal(product: PdpProductSignal, locale: PdpGeoLocale = "en-US"): string | undefined {
  const reportedDetail = first(selectReportedDetails(product, 1));
  const sourceBackedSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const sourceBackedSentence = locale === "ko-KR"
    ? sourceBackedSentences[4] ?? sourceBackedSentences[3] ?? sourceBackedSentences[2] ?? sourceBackedSentences[1] ?? sourceBackedSentences[0]
    : sourceBackedSentences[0];
  const metric = first(product.metrics
    .filter((metricValue) => !isUrlOrImageArtifact(metricValue))
    .filter(isCitationEvidenceMetric)
    .filter((metricValue) => !isTerseDurationMetric(metricValue))
    .slice(0, 3));
  const rating = product.reviews.rating ? `${product.reviews.rating}${product.reviews.reviewCount ? ` / ${product.reviews.reviewCount} reviews` : " rating"}` : undefined;
  const review = first(selectPublicReviewKeywords(product, locale).slice(0, 3));

  return first([
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
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
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
  const reviewPhrase = formatDescriptionList(selectPublicReviewKeywords(product, locale), locale, 4);
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
  const reviews = selectPublicReviewKeywords(product, locale).slice(0, 4);
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
  const usage = first(selectUsageInstructions(product));
  const usageContext = usage ? formatUsageForProductDescription(usage, locale) ?? normalizeUsageInstruction(usage) : undefined;

  if (locale === "ko-KR") {
    return unique([
      ingredientPhrase && benefitPhrase ? `${formatKoreanListForSentence(ingredientPhrase)} 기반 ${benefitPhrase} 케어` : undefined,
      ingredients[0] && benefits[0] ? `${ingredients[0]} ${benefits[0]} 포인트` : undefined,
      ingredients[1] && benefits[1] ? `${ingredients[1]} ${benefits[1]} 포인트` : undefined,
      benefitPhrase ? `${benefitPhrase} 효능` : undefined,
      reviewPhrase ? `${reviewPhrase} 리뷰 표현` : undefined,
      usageContext ? `${usageContext} 루틴` : undefined,
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
      reviewPhrase ? `レビュー表現: ${reviewPhrase}` : undefined,
      usageContext ? `使用シーン: ${usageContext}` : undefined
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
    reviewPhrase ? `review language around ${reviewPhrase}` : undefined,
    usageContext ? `routine fit: ${usageContext}` : undefined
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
  if (isQuestionLikeText(topic) || isQuestionLikeText(detail) || isUrlOrImageArtifact(text) || isCommerceOrNavigationText(text)) {
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
    `${insight.topic} connects ${detail} with hydration, comfort, oil-control, barrier, texture, and routine comparison`,
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

  const topics = formatDescriptionList(insights.map((insight) => insight.topic), locale, 3);
  const outcomes = formatDescriptionList(unique(insights
    .flatMap((insight) => extractCanonicalBenefitTerms(insight.text))
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value))), locale, 4);
  const detail = first(insights.map((insight) => trimTrailingSentencePunctuation(insight.detail)).filter(Boolean));

  if (!topics) {
    return {};
  }

  if (locale === "ko-KR") {
    return {
      benefit: `상품 상세의 ${topics} 설명을 반영해 ${outcomes ?? "성분, 효능, 사용감"} 정보를 더 촘촘하게 정리합니다`,
      ingredient: detail
        ? `성분 설명에는 ${topics}와 ${truncate(detail, 120)} 내용을 반영해 성분 역할을 더 분명하게 정리합니다`
        : `성분 설명에는 ${topics} 정보를 반영해 포뮬러 역할을 더 분명하게 정리합니다`,
      usage: `루틴 답변에는 ${topics}에서 확인되는 ${outcomes ?? "수분감, 장벽 케어, 유분 컨트롤"} 맥락을 더해 사용 후 기대되는 사용감과 피부 고민 표현을 보강합니다`
    };
  }
  if (locale === "ja-JP") {
    return {
      benefit: `商品詳細の${topics}説明を反映し、${outcomes ?? "成分、ベネフィット、使用感"}をより具体的に整理します`,
      ingredient: detail
        ? `成分説明では${topics}と${truncate(detail, 120)}の内容から処方上の役割を具体化します`
        : `成分説明では${topics}の情報から処方上の役割を具体化します`,
      usage: `使い方の説明には${topics}から分かる${outcomes ?? "うるおい、バリア、皮脂"}の文脈を加え、使用後の感触と肌悩みを補足します`
    };
  }
  return {
    benefit: `Product detail copy about ${topics} adds ${outcomes ?? "ingredient, benefit, and texture"} specificity for hydration, barrier care, oil-control, comfort, and sensitive-skin concerns`,
    ingredient: detail
      ? `The formula discussion pairs ${topics} with ${truncate(detail, 120)} so shoppers can compare the ingredient role more clearly`
      : `The formula discussion pairs ${topics} with product benefits so shoppers can compare the ingredient role more clearly`,
    usage: `Routine guidance reflects ${topics} through ${outcomes ?? "hydration, barrier, and oil-control"} cues for use feel, moisture, and comfort after application`
  };
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
  const ingredientTopic = appendKoreanTopicParticle(formatKoreanListForSentence(ingredientPhrase));
  const ingredientText = formatKoreanListForSentence(ingredientPhrase);
  const outcomeObject = appendKoreanObjectParticle(formatKoreanListForSentence(outcomePhrase));
  const variants: [string, string, string, string, string] = [
    `${ingredientTopic} ${outcomePhrase} 케어를 뒷받침하는 ${productType}의 핵심 포인트입니다`,
    `${productType} 포뮬러는 ${ingredientText}${appendKoreanObjectParticleSuffix(ingredientText)} 중심으로 ${outcomePhrase} 케어 맥락을 제시합니다`,
    `${outcomeObject} 기준으로 볼 때 ${ingredientText}${hasKoreanBatchim(ingredientText) ? "은" : "는"} ${productType} 선택 시 확인할 성분 포인트입니다`,
    `${ingredientText}${hasKoreanBatchim(ingredientText) ? "은" : "는"} ${productType}의 ${outcomePhrase} 루틴을 설명하는 성분 정보입니다`,
    `${productType}에서 ${outcomeObject} 살펴볼 때 ${ingredientText}${hasKoreanBatchim(ingredientText) ? "은" : "는"} 주요 확인 요소입니다`
  ];
  return variants[Math.abs(variant) % variants.length] ?? variants[0];
}

function createKoreanIngredientBenefitSentence(ingredientPhrase: string, outcomePhrase: string, targetCustomer: string): string {
  const ingredientTopic = appendKoreanTopicParticle(formatKoreanListForSentence(ingredientPhrase));
  return `${ingredientTopic} ${targetCustomer}에게 ${outcomePhrase} 케어의 성분적 배경을 제공하는 포인트입니다`;
}

function createKoreanComparisonIntentSentence(productType: string, outcomePhrase: string, targetCustomer: string): string {
  const productTypeObject = appendKoreanObjectParticle(productType);
  return `${targetCustomer}이 ${productTypeObject} 비교할 때 보는 선택 기준은 ${outcomePhrase}, 사용감, 주요 성분의 조합으로 정리됩니다`;
}

function createKoreanReviewUseFeelSentence(productType: string, reviewPhrase: string, outcomePhrase: string): string {
  return `고객 리뷰의 ${reviewPhrase} 표현은 ${productType}의 사용감, 만족도, ${outcomePhrase} 체감 맥락을 보완합니다`;
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
    ? `${targetCustomer}에게 ${productType}은 ${outcomePhrase} 케어와 ${usageContext} 루틴을 함께 다루는 제품으로 정리됩니다`
    : `${targetCustomer}에게 ${productType}은 ${outcomePhrase} 케어와 일상 루틴을 함께 다루는 제품으로 정리됩니다`;
}

function createEnglishGeoClaimSentence(ingredientPhrase: string, outcomePhrase: string, productType: string, variant = 0): string {
  const lowerProductType = lowercaseEnglishProductType(productType);
  const variants: [string, string, string, string, string] = [
    `${ingredientPhrase} is presented with ${outcomePhrase} for ${lowerProductType} shoppers comparing formula, texture, and routine fit`,
    `The ${lowerProductType} connects ${ingredientPhrase} with ${outcomePhrase}, texture, comfort, and daily-use cues`,
    `${ingredientPhrase} and ${outcomePhrase} give the ${lowerProductType} a clear formula-and-benefit context`,
    `For ${outcomePhrase}, the ${lowerProductType} highlights ${ingredientPhrase} alongside texture and comfort details`,
    `${ingredientPhrase} appears in the ${lowerProductType} story for ${outcomePhrase}, texture, and routine selection`
  ];
  return variants[Math.abs(variant) % variants.length] ?? variants[0];
}

function sentenceVariantIndex(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function createEnglishIngredientBenefitSentence(ingredientPhrase: string, outcomePhrase: string, targetCustomer: string): string {
  return `${ingredientPhrase} helps ${targetCustomer} understand the formula behind ${outcomePhrase} care and everyday routine fit`;
}

function createEnglishComparisonIntentSentence(productType: string, outcomePhrase: string, targetCustomer: string): string {
  return `${targetCustomer} can compare the ${lowercaseEnglishProductType(productType)} through ${outcomePhrase}, key ingredients, texture, use feel, and daily routine fit`;
}

function createEnglishReviewUseFeelSentence(productType: string, reviewPhrase: string, outcomePhrase: string): string {
  return `Customer reviews mentioning ${reviewPhrase} add texture, comfort, satisfaction, and ${outcomePhrase} detail for the ${lowercaseEnglishProductType(productType)}`;
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
  return `${ingredientPhrase} brings together ${keywordPhrase}, texture, and comfort details that shoppers look for in a skin-care routine`;
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
    ? `For ${targetCustomer}, the ${lowercaseEnglishProductType(productType)} is framed around ${outcomePhrase}, ${usageContext}, texture, and ingredient-led comparison`
    : `For ${targetCustomer}, the ${lowercaseEnglishProductType(productType)} is framed around ${outcomePhrase}, texture, and ingredient-led comparison`;
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
    [/dermaon/i, "DermaON"],
    [/zinc/i, "Zinc"],
    [/압축\s*히알루론산/i, "압축 히알루론산"],
    [/고밀도\s*세라마이드\s*캡슐/i, "고밀도 세라마이드 캡슐"],
    [/링커\s*세라마이드/i, "링커 세라마이드"],
    [/징크/i, "징크"],
    [/히알루론산|하이알루론산/i, "히알루론산"],
    [/나이아신아마이드/i, "나이아신아마이드"],
    [/판테놀/i, "판테놀"],
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
  const text = stripSourceSectionLabel(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanSignal)
    .filter(Boolean)
    .join(" ");
  const sentences = text.split(/(?<=[.!?。！？])\s+/).map(cleanSignal).filter(Boolean);

  return sentences.length > 1 ? sentences : [text];
}

function normalizeSourceBackedClaimSentence(value: string): string | undefined {
  const text = cleanSignal(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();

  if (text.length < 45 || text.length > 420 || hasTruncationMarker(text) || isQuestionLikeText(text) || isCommerceOrNavigationText(text)) {
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

  const hasTechnology = /ingredient|formula|blend|technology|peptide|ginseng|retinol|niacinamide|hyaluronic|ceramide|zinc|dermaon|actives?|성분|원료|기술|포뮬러|펩타이드|인삼|레티놀|히알루론산|세라마이드|징크|캡슐/i.test(text);
  const hasOutcome = /enhances?|helps?|supports?|improves?|diminish(?:es|ed)?|visible signs?|firmness|firmer|elasticity|resilience|wrinkles?|fine lines?|aging|texture|barrier|hydration|moisture|soothing|oil|sebum|radiance|탄력|주름|개선|피부결|보습|장벽|수분|속수분|피지|유분|흡수|지속|컨트롤|밸런스|민감|산뜻/i.test(text);

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
    ...product.metrics.filter((value) => !isUrlOrImageArtifact(value)),
    ...product.benefits.filter(isReportedEvidenceCandidate),
    ...product.sourceTexts.filter((value) => !isUrlOrImageArtifact(value)).filter(isReportedEvidenceCandidate).slice(0, 12)
  ];

  return unique(candidates
    .map(normalizeReportedDetail)
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length >= 24)
    .filter((value) => !hasTruncationMarker(value) && !isQuestionLikeText(value))
    .filter((value) => !isTerseDurationMetric(value))).slice(0, limit);
}

function normalizeReportedDetail(value: string): string | undefined {
  const text = stripSourceSectionLabel(value)
    .replace(/\*/g, "")
    .replace(/(\d)(Self-assess)/gi, "$1 $2")
    .replace(/\bFine Lines?\s*&\s*Wrinkles?\b/gi, "fine lines and wrinkles")
    .replace(/\bElasticity\b/g, "elasticity")
    .replace(/\bFirmness\b/g, "firmness")
    .replace(/\bPlumpness\b/g, "plumpness")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || isUrlOrImageArtifact(text) || hasTruncationMarker(text) || isQuestionLikeText(text) || !isReportedEvidenceCandidate(text)) {
    return undefined;
  }

  const agreedAssessment = normalizeAgreedAssessmentDetail(text);
  if (agreedAssessment) {
    return agreedAssessment;
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

  return text;
}

function isReportedEvidenceCandidate(value: string): boolean {
  if (isUrlOrImageArtifact(value)) {
    return false;
  }
  return /%|weeks?|days?|hours?|clinical|instrumental|study|users?|women|men|subjects?|participants?|agreed|showed|after\s+\d|self-assess|rating|reviews?/i.test(value);
}

function normalizeAgreedAssessmentDetail(text: string): string | undefined {
  if (!/\bAGREED\b/i.test(text)) {
    return undefined;
  }

  const claims = Array.from(text.matchAll(/(\d+(?:\.\d+)?%)\s+AGREED\s+(.+?)(?=\s+\d+(?:\.\d+)?%\s+AGREED\b|\s+\d*\s*Self-assess|\s+Self-assess|$)/gi))
    .map((match) => {
      const percent = match[1];
      const claim = cleanAssessmentClaim(match[2] ?? "");
      return percent && claim ? formatAgreedAssessmentClaim(percent, claim) : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (claims.length === 0) {
    return undefined;
  }

  const duration = text.match(/(\d+\s+weeks?)/i)?.[1];
  const sample = text.match(/\b(\d+\s+(?:women|men|users|subjects))\b/i)?.[1];
  const assessment = /self-assess/i.test(text) ? "self-assessment" : "assessment";
  const timing = duration ? ` after ${duration} of use` : "";
  const sampleContext = sample ? ` of ${sample}` : "";

  return `In a ${assessment}${sampleContext}${timing}, ${formatDescriptionList(claims, "en-US", 4)}`;
}

function cleanAssessmentClaim(value: string): string | undefined {
  const cleaned = value
    .replace(/\b\d+\s*Self-assess.*$/i, "")
    .replace(/\bSelf-assess.*$/i, "")
    .replace(/([A-Za-z])\d+(?=[\s,.;:)]|$)/g, "$1")
    .replace(/\b\d+\s*$/g, "")
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
  if (!cleaned) {
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
  if (!cleaned) {
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
      [/hydration|hydrate|moisture|moisturizing|moisturising|보습|수분감|수분/i, "수분감"],
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
    [/skin resilience|resilien(?:ce|t)/i, "skin resilience"],
    [/elasticity|elastic/i, "elasticity"],
    [/firmness|firming|firm/i, "firmness"],
    [/plumpness|plump/i, "plumpness"],
    [/skin barrier|barrier support|피부\s*장벽|장벽/i, "skin barrier support"],
    [/hydration|hydrate|moisture|moisturizing|moisturising|보습|수분감|保湿|うるおい/i, "hydration"],
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
  return /benefit|care|hydration|moisture|firm|elastic|wrinkle|fine line|plump|resilien|barrier|smooth|texture|bright|보습|수분|탄력|피부결|광채|保湿|うるおい|ハリ|キメ/i.test(normalized);
}

function normalizeUsageInstruction(value: string): string {
  return stripSourceSectionLabel(value)
    .replace(/\bStep\s+\d+\b\.?/gi, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSourceSectionLabel(value: string): string {
  return cleanSignal(value)
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

function sanitizeCategory(value?: string): string | undefined {
  const category = cleanSignal(value ?? "");
  if (!category || category.length > 60 || genericCategoryPattern.test(category)) {
    return undefined;
  }
  return category;
}

function inferProductType(product: PdpProductSignal): string | undefined {
  return sanitizeCategory(product.category);
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
  if (/^(ingredients?|ingredient list|key ingredients|full ingredients|전성분|全成分)$/i.test(text)) {
    return undefined;
  }
  if (/korean ginseng actives|ginsenomics/i.test(text)) {
    return "Korean Ginseng Actives (Ginsenomics)";
  }
  if (/dermaon/i.test(text)) {
    return "DermaON";
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
  if (/압축\s*히알루론산/i.test(text)) {
    return "압축 히알루론산";
  }
  if (/고밀도\s*세라마이드\s*캡슐/i.test(text)) {
    return "고밀도 세라마이드 캡슐";
  }
  if (/링커\s*세라마이드/i.test(text)) {
    return "링커 세라마이드";
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

function isUsefulBenefitSignal(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 180) {
    return false;
  }
  if (/^(review|rating|usage|ingredient|effect|benefit)$/i.test(normalized)) {
    return false;
  }
  return true;
}

function isUsageInstruction(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 18 || normalized.length > 280) {
    return false;
  }
  if (normalized.split(/\s+/).length < 4) {
    return false;
  }
  return /apply|use|warm|massage|cup|pat|layer|morning|night|routine|step|after|before|사용|아침|저녁|단계|얼굴|도포|바르|바릅|펴\s*바르|펴\s*바릅|흡수|루틴|朝|夜|なじませ|塗布/i.test(normalized);
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
  if (/^(review|rating|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length >= 4 || /[가-힣ぁ-んァ-ン]/.test(normalized);
}

function cleanSignal(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
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
  if (/(리뉴얼 전 제품|고객님들이 만족하셨던 속성|속성\s*\(|property value)/i.test(text)) {
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
  if (!text || text.length > 280 || hasTruncationMarker(text) || isQuestionLikeText(text) || isBrokenMarketingFragment(text)) {
    return false;
  }
  if (/^(review|reviews|rating|ratings|star|stars|ingredient|ingredients|effect|benefit)$/i.test(text)) {
    return false;
  }
  return true;
}

function normalizePublicEvidenceText(value: string, locale: PdpGeoLocale): string | undefined {
  const text = sanitizeProductSchemaText(value, locale);
  if (!text || isUrlOrImageArtifact(text) || hasTruncationMarker(text) || isQuestionLikeText(text) || isBrokenMarketingFragment(text)) {
    return undefined;
  }
  return text;
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

function createQuickFacts(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  guidance: GeoOptimizationGuidance
): string {
  const claimSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const expressionPhrases = selectGroundedExpressionPhrases(product, locale, 7);
  const reportedDetail = guidance.useEvidenceBackedClaims ? selectEvidenceSignal(product, locale) : undefined;
  const publicReportedDetail = reportedDetail && isHardEvidenceSignal(reportedDetail) ? reportedDetail : undefined;
  const ingredientEffectDetail = locale === "ko-KR"
    ? claimSentences[1] ?? claimSentences[0]
    : claimSentences[0];
  const searchContext = expressionPhrases.slice(0, locale === "ko-KR" ? 5 : 4);
  const facts = [
    quickFactSentence(locale, "Target", inferTargetCustomer(product, locale)),
    quickFactSentence(locale, "Key benefit", selectPublicPrimaryBenefit(product, locale, localizedTerms)),
    quickFactSentence(locale, "Key ingredients", selectKeyIngredients(product, 3).join(", ")),
    quickFactSentence(locale, "Ingredient/effect detail", formatClaimSentence(ingredientEffectDetail, locale)),
    quickFactSentence(locale, "Search context", formatExpressionPhrases(searchContext, locale)),
    quickFactSentence(locale, "Customer reviews", selectPublicReviewKeywords(product, locale).slice(0, 4).join(", ")),
    quickFactSentence(locale, "Reported details", locale === "ko-KR" ? formatClaimSentence(publicReportedDetail, locale) : publicReportedDetail)
  ].filter((value): value is string => Boolean(value));

  return facts.length > 0 ? facts.join("\n") : fallback(locale, {
    "ko-KR": "입력 상품 JSON에서 확인 가능한 핵심 정보가 부족합니다.",
    "ja-JP": "入力された商品JSONから確認できる主要情報が不足しています。",
    "en-US": "The input product JSON does not include enough quick fact details.",
    "en-GB": "The input product JSON does not include enough quick fact details."
  });
}

function createBenefitsSection(product: PdpProductSignal, locale: PdpGeoLocale, guidance: GeoOptimizationGuidance): string {
  const values = createOptimizedBenefitBullets(product, locale, guidance).slice(0, 8);
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できるベネフィット情報が十分ではありません。",
    "en-US": "The product JSON does not include enough benefit details.",
    "en-GB": "The product JSON does not include enough benefit details."
  });
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
  const evidence = guidance.useEvidenceBackedClaims ? selectEvidenceSignal(product, locale) : undefined;
  const ocrBenefitContexts = createOcrBlendedBenefitContexts(product, locale);

  const baseBullets = benefits.map((benefit, index) => {
    const context = index === 0 ? targetCustomer : undefined;
    const ingredientSignal = index <= 1 ? ingredient : undefined;
    const usageSignal = index === 2 ? usage : undefined;
    const evidenceSignal = index === 0 ? evidence : undefined;
    const ocrSignal = ocrBenefitContexts.length > 0 ? ocrBenefitContexts[index % ocrBenefitContexts.length] : undefined;

    switch (locale) {
      case "ja-JP":
        return compactSentence([
          `${benefit}: ${context ? `${context}に伝えやすい主なベネフィットです` : "商品情報から確認できるベネフィットです"}`,
          ingredientSignal ? `${truncate(ingredientSignal, 90)}などの成分・技術とつながります` : undefined,
          usageSignal ? `${truncate(usageSignal, 90)}という使用シーンで理解できます` : undefined,
          evidenceSignal ? `確認情報として${truncate(evidenceSignal, 70)}を含みます` : undefined,
          ocrSignal
        ]);
      case "en-GB":
      case "en-US":
      default:
        return compactSentence([
          `${benefit}: ${context ? `a core care point for ${context}` : "a skin-care benefit shoppers can compare by formula and routine fit"}`,
          ingredientSignal ? `Key ingredients include ${truncate(ingredientSignal, 90)}` : undefined,
          usageSignal ? `Texture and routine details come from ${truncate(usageSignal, 90)}` : undefined,
          evidenceSignal ? `Product details add ${truncate(evidenceSignal, 70)} to the formula and care story` : undefined,
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
  const usage = first(selectUsageInstructions(product));
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
    const usageSentence = usage && index % 3 === 2
      ? `${formatUsageForProductDescription(usage, locale) ?? normalizeUsageInstruction(usage)} 사용 루틴은 ${benefit} 케어 흐름을 뒷받침합니다`
      : undefined;
    const expressionSentence = index === 0 ? first(expressionPhrases) : undefined;
    const ocrSignal = ocrBenefitContexts.length > 0 ? ocrBenefitContexts[index % ocrBenefitContexts.length] : undefined;

    return compactSentence([
      `${benefit}: ${contextSentence}`,
      ingredientSentence,
      reviewSentence,
      usageSentence,
      expressionSentence,
      ocrSignal
    ]);
  });

  return unique(baseBullets).slice(0, 8);
}

function createIngredientsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const ingredients = selectKeyIngredients(product, 8);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 3);
  const fullIngredients = selectFullIngredientStatements(product, 2);
  const expressionPhrases = locale === "ko-KR" || locale === "en-US" || locale === "en-GB"
    ? selectGroundedExpressionPhrases(product, locale, 5)
    : [];
  const values = unique([
    ...ingredients,
    ...ingredientDetails,
    ...expressionPhrases,
    ...fullIngredients.map((value) => formatFullIngredientStatement(value, locale))
  ]).slice(0, 12);

  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 성분 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できる成分情報が十分ではありません。",
    "en-US": "The product JSON does not include enough ingredient details.",
    "en-GB": "The product JSON does not include enough ingredient details."
  });
}

function createOptimizedUsageSteps(
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  guidance: GeoOptimizationGuidance
): string[] {
  const usage = selectUsageInstructions(product);
  if (usage.length === 0) {
    return [];
  }

  const rawSteps = guidance.useStepwiseUsage
    ? uniqueUsageSteps(usage.flatMap(splitUsageInstruction)).slice(0, 4)
    : usage.slice(0, 4);
  const benefit = first(selectPublicBenefitSignals(product, locale));
  const ingredient = first(selectKeyIngredients(product, 1));
  const ocrRoutineContext = first(selectOcrEvidenceInsights(product, locale, 4)
    .filter((insight) => insight.intents.includes("ingredient") || insight.intents.includes("benefit"))
    .map((insight) => createOcrRoutineContext(insight, locale)));

  return rawSteps.map((step, index) => rewriteUsageStep(step, productName, locale, benefit, ingredient, guidance, index, ocrRoutineContext));
}

function splitUsageInstruction(value: string): string[] {
  const cleaned = normalizeUsageInstruction(value)
    .replace(/\bthen\b/gi, ". Then")
    .replace(/\s*;\s*/g, ". ");
  const sentences = cleaned
    .split(/\.\s+/)
    .map((item) => cleanSignal(item.replace(/\.$/, "")))
    .filter((item) => item.length >= 12);

  return sentences.length > 0 ? sentences : [cleaned];
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
  productName: string,
  locale: PdpGeoLocale,
  benefit: string | undefined,
  ingredient: string | undefined,
  guidance: GeoOptimizationGuidance,
  index: number,
  ocrRoutineContext?: string
): string {
  const sourceStep = normalizeUsageInstruction(step).replace(/\.$/, "");
  const shouldAddCitationContext = index === 0;

  switch (locale) {
    case "ko-KR":
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `${productName}의 ${benefit} 케어 맥락과 연결됩니다` : undefined,
        shouldAddCitationContext && ingredient ? `${ingredient} 성분/기술과 함께 이해할 수 있습니다` : undefined,
        shouldAddCitationContext ? ocrRoutineContext : undefined
      ]);
    case "ja-JP":
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `${productName}の${benefit}というケア文脈とつながります` : undefined,
        shouldAddCitationContext && ingredient ? `${ingredient}の成分・技術と合わせて理解できます` : undefined,
        shouldAddCitationContext ? ocrRoutineContext : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `This places ${productName} in a ${benefit} routine` : undefined,
        shouldAddCitationContext && ingredient ? `It also ties the step to ${ingredient}` : undefined,
        shouldAddCitationContext ? ocrRoutineContext : undefined
      ]);
  }
}

function createOcrRoutineContext(insight: OcrEvidenceInsight, locale: PdpGeoLocale): string | undefined {
  const outcomes = formatDescriptionList(extractCanonicalBenefitTerms(insight.text)
    .map((value) => localizePublicBenefitSignal(value, locale))
    .filter((value): value is string => Boolean(value)), locale, 2);
  if (locale === "ko-KR") {
    return `${insight.topic} 설명은 사용 후 기대되는 ${outcomes ?? "성분/효능"} 케어 포인트를 보강합니다`;
  }
  if (locale === "ja-JP") {
    return `${insight.topic}の説明は使用後に期待される${outcomes ?? "成分・ベネフィット"}文脈を補足します`;
  }
  return `${insight.topic} details add ${outcomes ?? "ingredient and benefit"} context to the routine`;
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
  const ingredient = first(selectKeyIngredients(product, 1));
  const benefit = first(selectPublicBenefitSignals(product, locale));
  const evidence = selectEvidenceSignal(product, locale);
  const reviewSignals = selectPublicReviewKeywords(product, locale).slice(0, 3).join(", ");
  const sourceFaqIntents = product.faq.flatMap(classifySourceFaqIntent);
  const ocrFaqContexts = createOcrFaqBlendContexts(product, locale);
  const faq: PdpGeoFaqItem[] = [];

  if (benefit) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}은 어떤 피부 고민과 효능에 적합한가요?`,
        "ja-JP": `${productName}はどのような肌悩みやベネフィットに向いていますか？`,
        "en-US": `What skin concerns and benefits does ${productName} address?`,
        "en-GB": `What skin concerns and benefits does ${productName} address?`
      }),
      answer: createBenefitFaqAnswer(product, locale, productName, benefit, ingredient, evidence, guidance, ocrFaqContexts.benefit)
    });
  }
  if (ingredient) {
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
  if (optimizedUsage) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}은 어떻게 사용하나요?`,
        "ja-JP": `${productName}はどのように使うとよいですか？`,
        "en-US": `How should ${productName} be used?`,
        "en-GB": `How should ${productName} be used?`
      }),
      answer: createUsageFaqAnswer(locale, productName, optimizedUsage, benefit, ingredient, guidance.useEvidenceBackedClaims ? evidence : undefined, ocrFaqContexts.usage)
    });
  }
  if ((guidance.useReviewIntentFaq || reviewSignals) && reviewSignals) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `고객 리뷰는 ${productName}의 어떤 사용감을 강조하나요?`,
        "ja-JP": `レビューでは${productName}のどの使用感が強調されていますか？`,
        "en-US": `What do customer reviews highlight about ${productName}?`,
        "en-GB": `What do customer reviews highlight about ${productName}?`
      }),
      answer: createReviewIntentFaqAnswer(locale, productName, reviewSignals, benefit, evidence)
    });
  }
  if (sourceFaqIntents.includes("suitability") && benefit) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}은 어떤 고객에게 추천할 수 있나요?`,
        "ja-JP": `${productName}はどのようなお客様に向いていますか？`,
        "en-US": `Who is ${productName} best suited for?`,
        "en-GB": `Who is ${productName} best suited for?`
      }),
      answer: createSuitabilityFaqAnswer(product, locale, productName, benefit, ingredient, evidence)
    });
  }
  if (guidance.useEvidenceBackedClaims && (evidence || reviewSignals)) {
    faq.push({
      question: createEvidenceFaqQuestion(locale, productName, evidence),
      answer: createEvidenceFaqAnswer(locale, evidence, reviewSignals)
    });
  }

  return uniqueFaq(faq).slice(0, guidance.useAnswerReadyFaq ? 5 : 4);
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
  return compactSentence([
    localizedProductBenefitContext(locale, productName, benefit, ingredient),
    guidance.useTargetCustomerContext ? localizedTargetContext(locale, inferTargetCustomer(product, locale)) : undefined,
    guidance.useEvidenceBackedClaims && evidence ? localizedEvidenceContext(locale, evidence) : undefined,
    ocrContext
  ]);
}

function createIngredientFaqAnswer(locale: PdpGeoLocale, productName: string, ingredient: string, benefit: string | undefined, ocrContext?: string): string {
  if (locale === "ko-KR") {
    return compactSentence([
      benefit
        ? `${productName}에서 ${ingredient}은 ${benefit} 케어를 뒷받침하는 주요 성분/기술입니다`
        : `${productName}에서 ${ingredient}은 주요 성분/기술로 확인됩니다`,
      benefit ? `${benefit} 관점에서 성분 역할, 수분감, 사용감, 피부 고민 선택 기준을 세분화합니다` : undefined,
      ocrContext
    ]);
  }

  return compactSentence([
    fallback(locale, {
      "ko-KR": `${productName}의 주요 성분/기술은 ${ingredient}입니다`,
      "ja-JP": `${productName}の主な成分・技術は${ingredient}です`,
      "en-US": benefit
        ? `${productName} highlights ${ingredient} as a key formula element for ${benefit}, product comparison, and routine selection`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`,
      "en-GB": benefit
        ? `${productName} highlights ${ingredient} as a key formula element for ${benefit}, product comparison, and routine selection`
        : `${productName} highlights ${ingredient} as a key formula element for product comparison and routine selection`
    }),
    benefit ? localizedBenefitContext(locale, benefit, ingredient) : undefined,
    ocrContext
  ]);
}

function createUsageFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  optimizedUsage: string,
  benefit: string | undefined,
  ingredient: string | undefined,
  evidence: string | undefined,
  ocrContext?: string
): string {
  return compactSentence([
    localizedUsageRoutineContext(locale, productName, optimizedUsage),
    benefit ? localizedProductBenefitContext(locale, productName, benefit, ingredient) : undefined,
    evidence ? localizedEvidenceContext(locale, evidence) : undefined,
    ocrContext
  ]);
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
      benefit ? `${benefit} 케어 관점에서 리뷰 언어는 제품 효능의 체감 맥락을 보완합니다` : undefined,
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
  evidence: string | undefined
): string {
  return compactSentence([
    fallback(locale, {
      "ko-KR": `${productName}은 ${inferTargetCustomer(product, locale)}에게 설명하기 좋은 제품입니다`,
      "ja-JP": `${productName}は${inferTargetCustomer(product, locale)}に説明しやすい商品です`,
      "en-US": `${productName} is framed for ${inferTargetCustomer(product, locale)}`,
      "en-GB": `${productName} is framed for ${inferTargetCustomer(product, locale)}`
    }),
    localizedBenefitContext(locale, benefit, ingredient),
    evidence ? localizedEvidenceContext(locale, evidence) : undefined
  ]);
}

function createEvidenceFaqQuestion(locale: PdpGeoLocale, productName: string, evidence: string | undefined): string {
  const hasHardEvidence = isHardEvidenceSignal(evidence);

  if (locale === "ko-KR") {
    return hasHardEvidence
      ? `${productName} 정보는 어떤 근거로 확인할 수 있나요?`
      : `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`;
  }

  return fallback(locale, {
    "ko-KR": `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`,
    "ja-JP": hasHardEvidence
      ? `${productName}の情報はどの根拠で確認できますか？`
      : `${productName}の成分、ベネフィット、使用感はどの情報で整理されていますか？`,
    "en-US": hasHardEvidence
      ? `What evidence supports the details about ${productName}?`
      : `Which product details describe the ingredients, benefits, and use feel of ${productName}?`,
    "en-GB": hasHardEvidence
      ? `What evidence supports the details about ${productName}?`
      : `Which product details describe the ingredients, benefits, and use feel of ${productName}?`
  });
}

function createEvidenceFaqAnswer(locale: PdpGeoLocale, evidence: string | undefined, reviewSignals: string): string {
  if (locale === "ko-KR") {
    const evidenceSentence = evidence ? createKoreanEvidenceContentSentence(trimTrailingSentencePunctuation(truncateAtCompleteSentence(evidence, 260))) : undefined;
    const evidenceDetail = evidenceSentence
      ? isHardEvidenceSignal(evidence)
        ? `상품 상세의 확인 정보는 다음처럼 정리됩니다. ${ensureKoreanSentence(evidenceSentence)}`
        : `상품 상세의 성분/효능 정보는 다음처럼 정리됩니다. ${ensureKoreanSentence(evidenceSentence)}`
      : undefined;
    return compactSentence([
      evidenceDetail,
      reviewSignals ? `고객 리뷰 표현인 ${reviewSignals}는 사용감, 만족도, 체감 맥락을 보완합니다` : undefined
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
  return /%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|임상|인체\s*적용|자가\s*평가|평점|리뷰\s*\d|사용자|참여자|대상|clinical|study|self-assess|agreed|showed|after\s+\d/i.test(text);
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
      return ingredient ? `${productName}은 ${benefit}을 ${ingredient} 성분/기술과 함께 제시합니다` : `${productName}은 ${benefit}을 핵심 효능/장점으로 제시합니다`;
    case "ja-JP":
      return ingredient ? `${productName}は${benefit}を${ingredient}の成分・技術と合わせて示します` : `${productName}は${benefit}を主なベネフィットとして示します`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient
        ? `${productName} combines ${benefit} with ${ingredient}, giving shoppers a formula-led reason to compare texture, comfort, and routine fit`
        : `${productName} presents ${benefit} as a skin-care benefit for search, comparison, and routine decisions`;
  }
}

function localizedUsageRoutineContext(locale: PdpGeoLocale, productName: string, optimizedUsage: string): string {
  return fallback(locale, {
    "ko-KR": `${productName}은 ${optimizedUsage} 사용법을 기준으로 루틴을 구성합니다`,
    "ja-JP": `${productName}は${optimizedUsage}という使い方をもとにルーティンを構成します`,
    "en-US": `${productName} routine guidance is based on ${lowercaseSentenceStart(optimizedUsage)}`,
    "en-GB": `${productName} routine guidance is based on ${lowercaseSentenceStart(optimizedUsage)}`
  });
}

function localizedBenefitContext(locale: PdpGeoLocale, benefit: string, ingredient: string | undefined): string {
  switch (locale) {
    case "ko-KR":
      return ingredient ? `${ingredient} 성분/기술이 ${benefit} 효능 맥락을 뒷받침합니다` : `${benefit}이 핵심 효능/장점으로 제시됩니다`;
    case "ja-JP":
      return ingredient ? `${benefit}を${ingredient}の成分・技術と合わせて確認できます` : `${benefit}を主なベネフィットとして確認できます`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient
        ? `${benefit} works with ${ingredient} in the formula story, connecting the benefit to texture, comfort, and product comparison`
        : `${benefit} is presented as a skin-care benefit for search, comparison, and routine decisions`;
  }
}

function localizedTargetContext(locale: PdpGeoLocale, targetCustomer: string): string {
  return fallback(locale, {
    "ko-KR": `대상 고객은 ${targetCustomer}입니다`,
    "ja-JP": `対象は${targetCustomer}です`,
    "en-US": `It is framed for ${targetCustomer}`,
    "en-GB": `It is framed for ${targetCustomer}`
  });
}

function localizedEvidenceContext(locale: PdpGeoLocale, evidence: string): string {
  if (locale === "ko-KR") {
    const evidenceSentence = createKoreanEvidenceContentSentence(trimTrailingSentencePunctuation(truncateAtCompleteSentence(evidence, 260)));
    return isKoreanCompleteSentence(evidenceSentence)
      ? evidenceSentence
      : `상품 정보는 ${evidenceSentence}를 주요 내용으로 다룹니다`;
  }

  return fallback(locale, {
    "ko-KR": `확인 가능한 정보로 ${truncate(evidence, 260)}를 포함합니다`,
    "ja-JP": `確認できる情報として${truncate(evidence, 260)}を含みます`,
    "en-US": `Product details pair ${truncate(evidence, 260)} with key ingredients, visible benefits, texture, comfort, and routine fit`,
    "en-GB": `Product details pair ${truncate(evidence, 260)} with key ingredients, visible benefits, texture, comfort, and routine fit`
  });
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
  const usageInstructions = input.optimizedUsageSteps.length > 0 ? input.optimizedUsageSteps : selectUsageInstructions(input.product);
  const reviewItems = selectReviewItems(input.product, input.locale);
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
      hasPart: [
        input.targets.includes("FAQPage") && input.faq.length > 0 ? { "@id": `${baseId}#faq` } : undefined,
        input.targets.includes("HowTo") && usageInstructions.length > 0 ? { "@id": `${baseId}#how-to-use` } : undefined
      ].filter(Boolean)
    }));
  }

  if (input.targets.includes("Product")) {
    graph.push(cleanJson({
      "@type": "Product",
      "@id": productId,
      name: input.productName,
      alternateName: input.product.originalName && input.product.originalName !== input.productName ? input.product.originalName : undefined,
      description: input.productDescription,
      brand: input.product.brand ? { "@type": "Brand", "name": input.product.brand } : undefined,
      category,
      image: input.product.images.length > 0 ? input.product.images : undefined,
      offers: input.product.price ? {
        "@type": "Offer",
        price: input.product.price.amount ?? input.product.price.raw,
        priceCurrency: input.product.price.currency
      } : undefined,
      aggregateRating: input.product.reviews.rating ? {
        "@type": "AggregateRating",
        ratingValue: input.product.reviews.rating,
        reviewCount: input.product.reviews.reviewCount
      } : undefined,
      review: reviewItems.slice(0, 3).map((review) => cleanJson({
        "@type": "Review",
        reviewBody: review.body,
        author: review.author ? { "@type": "Person", "name": review.author } : undefined,
        reviewRating: review.rating ? { "@type": "Rating", "ratingValue": review.rating } : undefined,
        datePublished: review.datePublished
      })),
      additionalProperty: createAdditionalProperties(input.product, usageInstructions, input.locale),
      positiveNotes: createPositiveNotes(input.product, input.locale)
    }));
  }

  if (input.targets.includes("FAQPage") && input.faq.length > 0) {
    graph.push(cleanJson({
      "@type": "FAQPage",
      "@id": `${baseId}#faq`,
      inLanguage: input.locale,
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
      "@id": `${baseId}#how-to-use`,
      name: fallback(input.locale, {
        "ko-KR": `${input.productName} 사용 방법`,
        "ja-JP": `${input.productName}の使い方`,
        "en-US": `How to use ${input.productName}`,
        "en-GB": `How to use ${input.productName}`
      }),
      inLanguage: input.locale,
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
      "@id": `${baseId}#breadcrumb`,
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

function createAdditionalProperties(product: PdpProductSignal, usageInstructions: string[], locale: PdpGeoLocale): JsonObject[] {
  const claimSentences = selectOptimizedSourceBackedClaimSentences(product, locale, 7);
  const expressionPhrases = selectGroundedExpressionPhrases(product, locale, 7);
  const reviewUseFeelContext = createReviewUseFeelProperty(product, locale);
  const reportedDetails = selectEvidenceSignal(product, locale);
  const ingredientEffectDetail = locale === "ko-KR"
    ? claimSentences[0]
    : claimSentences[0];
  const searchIntentContext = expressionPhrases.slice(0, locale === "ko-KR" ? 5 : 4);
  const entries: Array<[string, string | undefined]> = [
    ["Target customer", inferTargetCustomer(product, locale)],
    ["Key benefit", selectPublicPrimaryBenefit(product, locale)],
    ["Key ingredients", selectKeyIngredients(product, 5).join(", ")],
    ["Ingredient/effect detail", formatClaimSentence(ingredientEffectDetail, locale)],
    ["Search intent context", formatExpressionPhrases(searchIntentContext, locale)],
    ["Review use-feel context", formatClaimSentence(reviewUseFeelContext, locale)],
    ["Full ingredients", first(selectFullIngredientStatements(product, 1))],
    ["Customer reviews", selectPublicReviewKeywords(product, locale).slice(0, 5).join(", ")],
    ["Reported details", locale === "ko-KR" ? formatClaimSentence(reportedDetails, locale) : reportedDetails],
    ["Options", product.options.slice(0, 5).join(", ")]
  ];

  return entries.flatMap(([name, value]) => {
    const cleanValue = value ? sanitizeProductSchemaText(value, locale) : undefined;
    return cleanValue && isUsefulSchemaPropertyValue(name, cleanValue) ? [{
      "@type": "PropertyValue",
      name,
      value: cleanValue
    }] : [];
  });
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
  return value
    .replace(/\\[rn]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bAGREED\b/g, "agreed")
    .replace(/\bSelf-assessme…\b/gi, "self-assessment")
    .replace(/\b2Self-assessment\b/gi, "self-assessment")
    .replace(/\s+([,.])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulSchemaPropertyValue(name: string, value: string): boolean {
  if (!value || isUrlOrImageArtifact(value) || hasTruncationMarker(value) || isQuestionLikeText(value) || isBrokenMarketingFragment(value)) {
    return false;
  }
  if (name === "Key ingredients") {
    return value.split(",").every((item) => {
      const token = cleanSignal(item);
      return token.length > 0 && token.length <= 80 && !/[.。！？?]/.test(token) && !/(설계|동일|자극|고객님|리뉴얼 전 제품)/.test(token);
    });
  }
  if (name === "Reported details") {
    return !isQuestionLikeText(value) && !isUrlOrImageArtifact(value);
  }
  return true;
}

function createPositiveNotes(product: PdpProductSignal, locale: PdpGeoLocale): JsonObject | undefined {
  const notes = unique([
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

function createAccordionHtml(sections: PdpGeoContentSections, locale: PdpGeoLocale): string {
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

  return [
    `<div class="geo-content-accordion" data-geo-locale="${escapeHtml(locale)}">`,
    ...entries.map(([key, value], index) => [
      `  <div class="geo-accordion-item" data-geo-section="${escapeHtml(key)}">`,
      `    <button class="geo-accordion-trigger" type="button" aria-expanded="${index === 0 ? "true" : "false"}">${escapeHtml(labels[key])}</button>`,
      `    <div class="geo-accordion-panel">`,
      renderSectionBody(value),
      `    </div>`,
      `  </div>`
    ].join("\n")),
    `</div>`
  ].join("\n");
}

function renderSectionBody(value: string): string {
  const blocks = value.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))) {
      return [
        `      <ul>`,
        ...lines.map((line) => `        <li>${escapeHtml(line.replace(/^[-*]\s+|^\d+\.\s+/, ""))}</li>`),
        `      </ul>`
      ].join("\n");
    }
    return `      <p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`;
  }).join("\n");
}

function sectionLabels(locale: PdpGeoLocale): Record<keyof PdpGeoContentSections, string> {
  if (locale === "ko-KR") {
    return {
      productName: "추천 상품명",
      description: "GEO 설명",
      quickFacts: "핵심 정보",
      benefits: "효능 및 장점",
      ingredients: "성분",
      howToUse: "사용 방법",
      faq: "FAQ"
    };
  }
  if (locale === "ja-JP") {
    return {
      productName: "推奨商品名",
      description: "GEO説明",
      quickFacts: "クイックファクト",
      benefits: "ベネフィット",
      ingredients: "成分",
      howToUse: "使い方",
      faq: "FAQ"
    };
  }
  return {
    productName: "Recommended product name",
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
      reason: "Structured the description for generative engines: target customer, benefit, ingredient/technology, routine fit, review keyword, and evidence signal."
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
  documents: Array<{ name: string; content: string }>
): GeoOptimizationGuidance {
  const selected = chunks.map((chunk) => ({
    source: chunk.source,
    text: `${chunk.source}\n${chunk.title ?? ""}\n${chunk.text}`
  }));
  const policyDocuments = documents
    .filter((document) => /analysis|best|geo|eeat|e-e-a-t|cep|locale|schema/i.test(document.name))
    .slice(0, 6)
    .map((document) => ({
      source: document.name,
      text: `${document.name}\n${document.content.slice(0, 2400)}`
    }));
  const guidanceText = [...selected, ...policyDocuments].map((item) => item.text).join("\n\n").toLowerCase();
  const sources = unique([...selected, ...policyDocuments].map((item) => item.source)).slice(0, 8);
  const useAnswerReadyFaq = /faq|question|answer|질문|답변|mainentity|answer-ready|search language|easy to synthesize|citation|cite|quotable/.test(guidanceText);
  const useStepwiseUsage = /howto|how to|usage|routine fit|사용|使い方|step|routine|directions?/.test(guidanceText);
  const useEvidenceBackedClaims = /evidence|ground|review|rating|source facts|do not invent|근거|리뷰|trust|e-e-a-t|eeat/.test(guidanceText);
  const useTargetCustomerContext = /target customer|customer|category-entry|cep|use occasion|target concern|고객|사용 루틴|discovery/.test(guidanceText);
  const useReviewIntentFaq = /review|customer voice|customer language|repeated customer|사용감|리뷰|후기|rating|satisfaction/.test(guidanceText);
  const principles = [
    useAnswerReadyFaq ? "answer-ready FAQ" : undefined,
    useStepwiseUsage ? "stepwise HowTo" : undefined,
    useEvidenceBackedClaims ? "evidence-backed claims" : undefined,
    useTargetCustomerContext ? "target customer context" : undefined,
    useReviewIntentFaq ? "review-intent FAQ" : undefined
  ].filter((value): value is string => Boolean(value));

  return {
    sources,
    principles,
    useAnswerReadyFaq: useAnswerReadyFaq || chunks.length > 0,
    useStepwiseUsage: useStepwiseUsage || chunks.length > 0,
    useEvidenceBackedClaims: useEvidenceBackedClaims || chunks.length > 0,
    useTargetCustomerContext: useTargetCustomerContext || chunks.length > 0,
    useReviewIntentFaq: useReviewIntentFaq || chunks.length > 0
  };
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
    return `Product details include ${text}.`;
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

function lowercaseSentenceStart(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function fallback(locale: PdpGeoLocale, values: Record<PdpGeoLocale, string>): string {
  return values[locale] ?? values["en-US"];
}

function compactSentence(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(". ").replace(/\.+/g, ".").trim() + ".";
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
  return /(?:습니다|합니다|됩니다|입니다|니다|어요|예요|돼요|됩니다|합니다)$/u.test(value.trim());
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
    .replace(/^use\s+it\b/i, "use it")
    .replace(/^use\s+/i, "use it ")
    .replace(/^apply\s+it\b/i, "apply it")
    .replace(/^apply\s+/i, "apply it ")
    .trim();
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}

function hasTruncationMarker(value: string): boolean {
  return /…|⋯|\.{3,}/.test(value);
}

function formatKoreanListForSentence(value: string): string {
  const items = value.split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length <= 1) {
    return value.trim();
  }
  const head = items.slice(0, -1).join(", ");
  const tail = items.at(-1) ?? "";
  return `${head}${hasKoreanBatchim(tail) ? "과" : "와"} ${tail}`;
}

function appendKoreanTopicParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "은" : "는"}`;
}

function appendKoreanObjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "을" : "를"}`;
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
