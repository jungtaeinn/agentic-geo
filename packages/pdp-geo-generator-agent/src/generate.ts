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
    quickFacts: applyAvoidTerms(createQuickFacts(input.product, input.locale, localizedTerms, guidance, optimizedUsageSteps), terminologyConcepts, input.locale, terminology),
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
    { field: "content.description", source: "rag", value: `Description follows target customer + benefits + ingredients/technology + use context + review keywords + evidence. ${input.ragChunks.length} RAG chunks selected.` }
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
      reason: "Official AI/search platform docs were selected to guide retrieval, structured data, grounding, and citation constraints."
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

function createGeoProductName(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[], hints?: PdpGeoGenerationHints): string {
  const base = product.name.trim();
  const category = sanitizeCategory(hints?.category ?? product.category) ?? inferProductType(product);
  const primaryTerm = selectPrimaryBenefit(product, localizedTerms);

  if (!category || base.toLowerCase().includes(category.toLowerCase())) {
    return base;
  }

  if (primaryTerm && !base.toLowerCase().includes(primaryTerm.toLowerCase())) {
    return locale === "ja-JP"
      ? `${base} ${primaryTerm}${category}`
      : `${base} ${primaryTerm} ${category}`;
  }

  return `${base} ${category}`;
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
        context.ingredientPhrase ? `성분 영역에서는 ${context.ingredientPhrase}${context.ingredientDetail ? ` 등 주요 성분 설명` : ""}을 확인할 수 있습니다` : undefined,
        context.reviewPhrase ? `리뷰 기반 표현으로는 ${context.reviewPhrase}가 함께 노출됩니다` : undefined,
        context.reportedDetail ? `확인된 결과/정보로 ${truncate(context.reportedDetail, 420)}를 참고할 수 있습니다` : undefined
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
        `This ${productName} product page helps ${context.targetCustomer} evaluate the ${lowercaseEnglishProductType(context.productType)} through detailed benefit, ingredient, usage, and customer-review information`,
        context.benefitPhrase ? `It covers benefits such as ${context.benefitPhrase}` : undefined,
        context.ingredientPhrase ? `It surfaces key ingredients and technologies including ${context.ingredientPhrase}${context.ingredientDetail ? `, with ingredient context such as ${context.ingredientDetail}` : ""}` : undefined,
        context.reviewPhrase ? `It also reflects customer review language such as ${context.reviewPhrase}` : undefined,
        context.reportedDetail ? `Reported results or product details include ${truncate(context.reportedDetail, 420)}` : undefined
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
  reportedDetail?: string;
}

function createDescriptionContext(
  product: PdpProductSignal,
  productName: string,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  optimizedUsageSteps: string[]
): DescriptionContext {
  const productType = sanitizeCategory(product.category) ?? inferProductType(product) ?? fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const benefits = unique([
    ...selectBenefitSignals(product),
    ...localizedTerms.filter(isUsefulBenefitSignal)
  ]).slice(0, 5);
  const ingredients = selectKeyIngredients(product, 5);
  const ingredientDetails = selectIngredientDetails(product, ingredients, 2);
  const reviewKeywords = selectReviewKeywords(product).slice(0, 5);
  const representativeReviews = selectRepresentativeReviewPhrases(product, 2);

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
    reportedDetail: first(selectReportedDetails(product, 2)) ?? (product.description && benefits.length === 0 ? truncate(product.description, 120) : undefined)
  };
}

function createProductIngredientDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (!context.ingredientPhrase) {
    return undefined;
  }

  switch (locale) {
    case "ko-KR":
      return context.ingredientDetail
        ? `주요 성분/기술은 ${context.ingredientPhrase}이며, 성분 설명은 ${context.ingredientDetail}에 초점을 둡니다`
        : `주요 성분/기술은 ${context.ingredientPhrase}입니다`;
    case "ja-JP":
      return context.ingredientDetail
        ? `主な成分・技術は${context.ingredientPhrase}で、成分説明は${context.ingredientDetail}に焦点を当てています`
        : `主な成分・技術は${context.ingredientPhrase}です`;
    case "en-GB":
    case "en-US":
    default:
      return context.ingredientDetail
        ? `The formula highlights ${context.ingredientPhrase}; ingredient context focuses on ${context.ingredientDetail}`
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

  return fallback(locale, {
    "ko-KR": `확인된 상품 정보는 ${cleanEvidence}입니다`,
    "ja-JP": `確認できる商品情報は${cleanEvidence}です`,
    "en-US": `Reported product details include ${cleanEvidence}`,
    "en-GB": `Reported product details include ${cleanEvidence}`
  });
}

function createLocalizedReviewDescription(locale: PdpGeoLocale, context: DescriptionContext): string | undefined {
  if (context.representativeReviewPhrase) {
    switch (locale) {
      case "ko-KR":
        return `대표 고객 리뷰에서는 ${context.representativeReviewPhrase}처럼 설명되며${context.reviewPhrase ? `, ${context.reviewPhrase} 같은 반복 표현도 함께 확인됩니다` : ""}`;
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
    "ko-KR": `고객 리뷰에서는 ${context.reviewPhrase} 같은 표현이 확인되어 사용감과 기대 효능을 함께 보여줍니다`,
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
    "ko-KR": "상품의 핵심 효능과 사용 맥락을 빠르게 확인하려는 고객",
    "ja-JP": "商品の主な特徴と使用シーンを知りたいお客様",
    "en-US": "customers comparing the product's key benefits and use context",
    "en-GB": "customers comparing the product's key benefits and use context"
  });
}

function selectPrimaryBenefit(product: PdpProductSignal, localizedTerms: string[] = []): string | undefined {
  return first([...selectBenefitSignals(product), ...localizedTerms].filter(isUsefulBenefitSignal));
}

function selectBenefitSignals(product: PdpProductSignal): string[] {
  return unique([
    ...product.benefits.flatMap(extractBenefitSignalCandidates),
    ...product.effects.flatMap(extractBenefitSignalCandidates),
    ...selectReviewKeywords(product)
  ].map(normalizeBenefitSignal).filter((value): value is string => Boolean(value)).filter(isUsefulBenefitSignal)).slice(0, 10);
}

function selectKeyIngredients(product: PdpProductSignal, limit: number): string[] {
  const haystack = product.ingredients.join(" ");
  const detected = [
    /korean ginseng actives|ginsenomics/i.test(haystack) ? "Korean Ginseng Actives (Ginsenomics)" : undefined,
    /ginseng peptide/i.test(haystack) ? "Ginseng Peptide" : undefined,
    /retinol/i.test(haystack) ? "Retinol-infused capsules" : undefined,
    /niacinamide/i.test(haystack) ? "Niacinamide" : undefined,
    /hyaluronic|sodium hyaluronate/i.test(haystack) ? "Hyaluronic Acid" : undefined,
    /ceramide/i.test(haystack) ? "Ceramide" : undefined
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

  return uniqueValues.filter((value) => {
    if (hasRetinolCapsule && /^retinol$/i.test(value)) {
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
    .filter((value) => !value.includes("…"))).slice(0, limit);
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

function selectReviewItems(product: PdpProductSignal): PdpGeoReviewItem[] {
  const seen = new Set<string>();
  return product.reviews.items
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

function selectRepresentativeReviewPhrases(product: PdpProductSignal, limit: number): string[] {
  return unique(product.reviews.items
    .map((review) => normalizeRepresentativeReviewPhrase(review.body))
    .filter((value): value is string => Boolean(value))).slice(0, limit);
}

function normalizeRepresentativeReviewPhrase(value: string): string | undefined {
  const normalized = cleanSignal(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .trim();

  if (!isRepresentativeReviewPhrase(normalized)) {
    return undefined;
  }

  return `"${truncate(normalized, 120)}"`;
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

function selectEvidenceSignal(product: PdpProductSignal): string | undefined {
  const reportedDetail = first(selectReportedDetails(product, 1));
  const metric = first(product.metrics.filter(isCitationEvidenceMetric).filter((metricValue) => !isTerseDurationMetric(metricValue)).slice(0, 3));
  const rating = product.reviews.rating ? `${product.reviews.rating}${product.reviews.reviewCount ? ` / ${product.reviews.reviewCount} reviews` : " rating"}` : undefined;
  const review = first(selectReviewKeywords(product).slice(0, 3));

  return first([
    reportedDetail,
    metric,
    rating,
    review ? `review language: ${review}` : undefined,
    product.description ? truncate(product.description, 90) : undefined
  ]);
}

function selectReportedDetails(product: PdpProductSignal, limit: number): string[] {
  const candidates = [
    ...product.effects,
    ...product.metrics,
    ...product.benefits.filter((value) => /\d|%|weeks?|days?|hours?|clinical|instrumental|study|users?|women|men|subjects?/i.test(value)),
    ...product.sourceTexts.filter((value) => /\d|%|weeks?|days?|hours?|clinical|instrumental|study|users?|women|men|subjects?/i.test(value)).slice(0, 12)
  ];

  return unique(candidates
    .map(normalizeReportedDetail)
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length >= 24)
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

  if (!text || !/\d|%|weeks?|days?|hours?|clinical|instrumental|study|users?|women|men|subjects?/i.test(text)) {
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

  return truncate(text, 170);
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

function extractCanonicalBenefitTerms(value: string): string[] {
  const terms: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/anti[-\s]?aging/i, "anti-aging care"],
    [/fine lines?\s*(?:&|and)\s*wrinkles?|wrinkles?\s*(?:&|and)\s*fine lines?/i, "fine lines and wrinkles"],
    [/skin resilience|resilien(?:ce|t)/i, "skin resilience"],
    [/elasticity|elastic/i, "elasticity"],
    [/firmness|firming|firm/i, "firmness"],
    [/plumpness|plump/i, "plumpness"],
    [/skin barrier|barrier support/i, "skin barrier support"],
    [/hydration|hydrate|moisture|moisturizing|moisturising|보습|수분감|保湿|うるおい/i, "hydration"],
    [/smooth(?:ness)?|texture|피부결|매끄|キメ/i, "smooth texture"],
    [/brightening|even-looking tone|광채|화사|透明感/i, "brightening"]
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
  const text = `${product.name} ${product.description ?? ""} ${product.sourceTexts.slice(0, 8).join(" ")}`;
  if (/serum|세럼|美容液/i.test(text)) {
    return "Serum";
  }
  if (/cream|크림|クリーム/i.test(text)) {
    return "Cream";
  }
  if (/toner|토너|化粧水/i.test(text)) {
    return "Toner";
  }
  if (/cleanser|클렌저|洗顔/i.test(text)) {
    return "Cleanser";
  }
  if (/mask|마스크|マスク/i.test(text)) {
    return "Mask";
  }
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
  if (/korean ginseng actives|ginsenomics/i.test(text)) {
    return "Korean Ginseng Actives (Ginsenomics)";
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
  if (/^water\s*\/\s*aqua/i.test(text) || text.split(",").length > 8) {
    return undefined;
  }
  return truncate(text, 120);
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
  return /apply|use|warm|massage|cup|pat|layer|morning|night|사용|도포|바르|흡수|朝|夜|なじませ|塗布/i.test(normalized);
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

function createQuickFacts(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  localizedTerms: string[],
  guidance: GeoOptimizationGuidance,
  optimizedUsageSteps: string[] = []
): string {
  const facts = [
    labelValue(locale, "Target", inferTargetCustomer(product, locale)),
    labelValue(locale, "Key benefit", selectPrimaryBenefit(product, localizedTerms)),
    labelValue(locale, "Key ingredients", selectKeyIngredients(product, 3).join(", ")),
    labelValue(locale, "Use context", first(optimizedUsageSteps) ?? first(selectUsageInstructions(product))),
    labelValue(locale, "Customer reviews", selectReviewKeywords(product).slice(0, 4).join(", ")),
    labelValue(locale, "Reported details", guidance.useEvidenceBackedClaims ? selectEvidenceSignal(product) : undefined)
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
  const benefits = selectBenefitSignals(product).slice(0, 6);
  const targetCustomer = guidance.useTargetCustomerContext ? inferTargetCustomer(product, locale) : undefined;
  const ingredients = selectKeyIngredients(product, 3);
  const ingredient = ingredients.join(", ");
  const usage = first(selectUsageInstructions(product));
  const evidence = guidance.useEvidenceBackedClaims ? selectEvidenceSignal(product) : undefined;

  return benefits.map((benefit, index) => {
    const context = index === 0 ? targetCustomer : undefined;
    const ingredientSignal = index <= 1 ? ingredient : undefined;
    const usageSignal = index === 2 ? usage : undefined;
    const evidenceSignal = index === 0 ? evidence : undefined;

    switch (locale) {
      case "ko-KR":
        return compactSentence([
          `${benefit}: ${context ? `${context}에게 설명하기 쉬운 핵심 케어입니다` : "상품 원문에서 확인된 효능/장점입니다"}`,
          ingredientSignal ? `${truncate(ingredientSignal, 90)} 성분/기술과 연결됩니다` : undefined,
          usageSignal ? `${truncate(usageSignal, 90)} 사용 맥락에서 이해할 수 있습니다` : undefined,
          evidenceSignal ? `확인 정보로 ${truncate(evidenceSignal, 70)}를 포함합니다` : undefined
        ]);
      case "ja-JP":
        return compactSentence([
          `${benefit}: ${context ? `${context}に伝えやすい主なベネフィットです` : "商品情報から確認できるベネフィットです"}`,
          ingredientSignal ? `${truncate(ingredientSignal, 90)}などの成分・技術とつながります` : undefined,
          usageSignal ? `${truncate(usageSignal, 90)}という使用シーンで理解できます` : undefined,
          evidenceSignal ? `確認情報として${truncate(evidenceSignal, 70)}を含みます` : undefined
        ]);
      case "en-GB":
      case "en-US":
      default:
        return compactSentence([
          `${benefit}: ${context ? `a core care point for ${context}` : "a benefit confirmed in the product information"}`,
          ingredientSignal ? `It is connected to ingredients or technologies such as ${truncate(ingredientSignal, 90)}` : undefined,
          usageSignal ? `It is easiest to understand in the use context: ${truncate(usageSignal, 90)}` : undefined,
          evidenceSignal ? `Source information includes ${truncate(evidenceSignal, 70)}` : undefined
        ]);
    }
  });
}

function createIngredientsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const ingredients = selectKeyIngredients(product, 8);
  return ingredients.length > 0 ? ingredients.map((value) => `- ${value}`).join("\n") : fallback(locale, {
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
  const benefit = first(selectBenefitSignals(product));
  const ingredient = first(selectKeyIngredients(product, 1));

  return rawSteps.map((step, index) => rewriteUsageStep(step, productName, locale, benefit, ingredient, guidance, index));
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
  index: number
): string {
  const sourceStep = normalizeUsageInstruction(step).replace(/\.$/, "");
  const shouldAddCitationContext = index === 0;

  switch (locale) {
    case "ko-KR":
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `${productName}의 ${benefit} 케어 맥락과 연결됩니다` : undefined,
        shouldAddCitationContext && ingredient ? `${ingredient} 성분/기술과 함께 이해할 수 있습니다` : undefined
      ]);
    case "ja-JP":
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `${productName}の${benefit}というケア文脈とつながります` : undefined,
        shouldAddCitationContext && ingredient ? `${ingredient}の成分・技術と合わせて理解できます` : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        sourceStep,
        shouldAddCitationContext && guidance.useTargetCustomerContext && benefit ? `This places ${productName} in a ${benefit} routine` : undefined,
        shouldAddCitationContext && ingredient ? `It also ties the step to ${ingredient}` : undefined
      ]);
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
  const ingredient = first(selectKeyIngredients(product, 1));
  const benefit = first(selectBenefitSignals(product));
  const evidence = selectEvidenceSignal(product);
  const reviewSignals = selectReviewKeywords(product).slice(0, 3).join(", ");
  const sourceFaqIntents = product.faq.flatMap(classifySourceFaqIntent);
  const faq: PdpGeoFaqItem[] = [];

  if (benefit) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}은 어떤 피부 고민과 효능에 적합한가요?`,
        "ja-JP": `${productName}はどのような肌悩みやベネフィットに向いていますか？`,
        "en-US": `What skin concerns and benefits does ${productName} address?`,
        "en-GB": `What skin concerns and benefits does ${productName} address?`
      }),
      answer: createBenefitFaqAnswer(product, locale, productName, benefit, ingredient, evidence, guidance)
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
      answer: createIngredientFaqAnswer(locale, productName, ingredient, benefit)
    });
  }
  if (optimizedUsage) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}은 어떻게 사용하면 좋나요?`,
        "ja-JP": `${productName}はどのように使うとよいですか？`,
        "en-US": `How should ${productName} be used?`,
        "en-GB": `How should ${productName} be used?`
      }),
      answer: createUsageFaqAnswer(locale, productName, optimizedUsage, benefit, ingredient, guidance.useEvidenceBackedClaims ? evidence : undefined)
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
      question: fallback(locale, {
        "ko-KR": `${productName} 정보는 무엇으로 확인할 수 있나요?`,
        "ja-JP": `${productName}の情報は何で確認できますか？`,
        "en-US": `What information supports the details about ${productName}?`,
        "en-GB": `What information supports the details about ${productName}?`
      }),
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
  guidance: GeoOptimizationGuidance
): string {
  return compactSentence([
    localizedProductBenefitContext(locale, productName, benefit, ingredient),
    guidance.useTargetCustomerContext ? localizedTargetContext(locale, inferTargetCustomer(product, locale)) : undefined,
    guidance.useEvidenceBackedClaims && evidence ? localizedEvidenceContext(locale, evidence) : undefined
  ]);
}

function createIngredientFaqAnswer(locale: PdpGeoLocale, productName: string, ingredient: string, benefit: string | undefined): string {
  return compactSentence([
    fallback(locale, {
      "ko-KR": `${productName}의 주요 성분/기술은 ${ingredient}입니다`,
      "ja-JP": `${productName}の主な成分・技術は${ingredient}です`,
      "en-US": `${productName} highlights ${ingredient} as a key ingredient or technology`,
      "en-GB": `${productName} highlights ${ingredient} as a key ingredient or technology`
    }),
    benefit ? localizedBenefitContext(locale, benefit, undefined) : undefined
  ]);
}

function createUsageFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  optimizedUsage: string,
  benefit: string | undefined,
  ingredient: string | undefined,
  evidence: string | undefined
): string {
  return compactSentence([
    localizedUsageRoutineContext(locale, productName, optimizedUsage),
    benefit ? localizedProductBenefitContext(locale, productName, benefit, ingredient) : undefined,
    evidence ? localizedEvidenceContext(locale, evidence) : undefined
  ]);
}

function createReviewIntentFaqAnswer(
  locale: PdpGeoLocale,
  productName: string,
  reviewSignals: string,
  benefit: string | undefined,
  evidence: string | undefined
): string {
  return compactSentence([
    fallback(locale, {
      "ko-KR": `고객 리뷰에서는 ${reviewSignals} 표현으로 ${productName}을 설명합니다`,
      "ja-JP": `レビューでは${reviewSignals}という表現で${productName}が説明されています`,
      "en-US": `Customer reviews describe ${productName} with phrases such as ${reviewSignals}`,
      "en-GB": `Customer reviews describe ${productName} with phrases such as ${reviewSignals}`
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

function createEvidenceFaqAnswer(locale: PdpGeoLocale, evidence: string | undefined, reviewSignals: string): string {
  return compactSentence([
    evidence ? localizedEvidenceContext(locale, evidence) : undefined,
    reviewSignals ? fallback(locale, {
      "ko-KR": `고객 리뷰에서는 ${reviewSignals} 같은 표현을 확인할 수 있습니다`,
      "ja-JP": `レビューでは${reviewSignals}などの表現を確認できます`,
      "en-US": `Customer reviews include phrases such as ${reviewSignals}`,
      "en-GB": `Customer reviews include phrases such as ${reviewSignals}`
    }) : undefined
  ]);
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
      return ingredient ? `${productName} connects ${benefit} with ${ingredient}` : `${productName} presents ${benefit} as a main benefit`;
  }
}

function localizedUsageRoutineContext(locale: PdpGeoLocale, productName: string, optimizedUsage: string): string {
  return fallback(locale, {
    "ko-KR": `${productName} 사용 루틴은 다음 사용법을 기준으로 구성합니다: ${optimizedUsage}`,
    "ja-JP": `${productName}の使用ルーティンは次の使い方を基準に構成します: ${optimizedUsage}`,
    "en-US": `${productName} usage routine is composed from this use context: ${optimizedUsage}`,
    "en-GB": `${productName} usage routine is composed from this use context: ${optimizedUsage}`
  });
}

function localizedBenefitContext(locale: PdpGeoLocale, benefit: string, ingredient: string | undefined): string {
  switch (locale) {
    case "ko-KR":
      return ingredient ? `${benefit}을 ${ingredient} 성분/기술과 함께 확인할 수 있습니다` : `${benefit}을 핵심 효능/장점으로 확인할 수 있습니다`;
    case "ja-JP":
      return ingredient ? `${benefit}を${ingredient}の成分・技術と合わせて確認できます` : `${benefit}を主なベネフィットとして確認できます`;
    case "en-GB":
    case "en-US":
    default:
      return ingredient ? `${benefit} is connected with ${ingredient}` : `${benefit} is the main benefit`;
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
  return fallback(locale, {
    "ko-KR": `확인 가능한 정보로 ${truncate(evidence, 260)}를 포함합니다`,
    "ja-JP": `確認できる情報として${truncate(evidence, 260)}を含みます`,
    "en-US": `Available product information includes ${truncate(evidence, 260)}`,
    "en-GB": `Available product information includes ${truncate(evidence, 260)}`
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
  const reviewItems = selectReviewItems(input.product);
  const category = sanitizeCategory(input.product.category) ?? inferProductType(input.product);
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
      positiveNotes: createPositiveNotes(input.product)
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
  const entries: Array<[string, string | undefined]> = [
    ["Target customer", inferTargetCustomer(product, locale)],
    ["Key benefit", selectPrimaryBenefit(product)],
    ["Key ingredients", selectKeyIngredients(product, 5).join(", ")],
    ["Use context", first(usageInstructions) ?? first(selectUsageInstructions(product))],
    ["Customer reviews", selectReviewKeywords(product).slice(0, 5).join(", ")],
    ["Reported details", selectEvidenceSignal(product)],
    ["Options", product.options.slice(0, 5).join(", ")]
  ];

  return entries.flatMap(([name, value]) => value ? [{
    "@type": "PropertyValue",
    name,
    value: sanitizeProductSchemaText(value)
  }] : []);
}

function sanitizeProductSchemaText(value: string): string {
  return value
    .replace(/\\[rn]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bAGREED\b/g, "agreed")
    .replace(/\bSelf-assessme…\b/gi, "self-assessment")
    .replace(/\b2Self-assessment\b/gi, "self-assessment")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function createPositiveNotes(product: PdpProductSignal): JsonObject | undefined {
  const notes = selectBenefitSignals(product).slice(0, 6);
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
      reason: "Added one concise locale-aware category or benefit phrase to make the product entity easier to cite without keyword stuffing."
    });
  }
  recommendations.push({
    field: "description",
    message: sections.description,
    reason: "Structured the description for generative engines: target customer, benefit, ingredient/technology, use context, review keyword, and evidence signal."
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
      reason: "Review-backed positive keywords were included as citation-friendly product signals."
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
      reason: "Reframed FAQ around GEO question intent, customer review signals, product benefit, ingredient/technology, usage context, and evidence signals so generated answers stay grounded and quotable."
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
  const useStepwiseUsage = /howto|how to|usage|use context|사용|使い方|step|routine|directions?/.test(guidanceText);
  const useEvidenceBackedClaims = /evidence|ground|review|rating|source facts|do not invent|근거|리뷰|trust|e-e-a-t|eeat/.test(guidanceText);
  const useTargetCustomerContext = /target customer|customer|category-entry|cep|use occasion|target concern|고객|사용 맥락|discovery/.test(guidanceText);
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

function labelValue(locale: PdpGeoLocale, label: string, value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const labels: Record<string, Partial<Record<PdpGeoLocale, string>>> = {
    Target: { "ko-KR": "대상", "ja-JP": "対象", "en-US": "Target", "en-GB": "Target" },
    "Key benefit": { "ko-KR": "핵심 효능", "ja-JP": "主なベネフィット", "en-US": "Key benefit", "en-GB": "Key benefit" },
    "Key ingredients": { "ko-KR": "주요 성분", "ja-JP": "主な成分", "en-US": "Key ingredients", "en-GB": "Key ingredients" },
    "Use context": { "ko-KR": "사용 맥락", "ja-JP": "使用シーン", "en-US": "Use context", "en-GB": "Use context" },
    "Customer reviews": { "ko-KR": "고객 리뷰", "ja-JP": "レビュー", "en-US": "Customer reviews", "en-GB": "Customer reviews" },
    "Reported details": { "ko-KR": "확인된 정보", "ja-JP": "確認できる情報", "en-US": "Reported details", "en-GB": "Reported details" }
  };
  return `${labels[label]?.[locale] ?? label}: ${value}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
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

  return truncate(value, limit);
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.。]+$/g, "").trim();
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}

function first(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
