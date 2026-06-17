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

const defaultTargets: PdpGeoSchemaTarget[] = ["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList"];

const genericCategoryPattern = /^(usage|use|how to use|direction|directions|review|reviews|rating|ratings|benefit|benefits|effect|effects|ingredient|ingredients|content|section|product|item|type)$/i;

/** Builds deterministic GEO artifacts from normalized product signals and selected RAG chunks. */
export function generatePdpGeoArtifacts(input: GenerateArtifactsInput): GenerateArtifactsOutput {
  const terminologyConcepts = readTerminologyConcepts(input.ragDocuments);
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
  const faq = ensureFaq(input.product, input.locale, productName);
  const sections: PdpGeoContentSections = {
    productName,
    description: applyAvoidTerms(createGeoDescription(input.product, productName, input.locale, localizedTerms), terminologyConcepts, input.locale, terminology),
    quickFacts: applyAvoidTerms(createQuickFacts(input.product, input.locale, localizedTerms), terminologyConcepts, input.locale, terminology),
    benefits: applyAvoidTerms(createBenefitsSection(input.product, input.locale), terminologyConcepts, input.locale, terminology),
    ingredients: applyAvoidTerms(createIngredientsSection(input.product, input.locale), terminologyConcepts, input.locale, terminology),
    howToUse: applyAvoidTerms(createHowToUseSection(input.product, input.locale), terminologyConcepts, input.locale, terminology),
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

  recommendations.push(...createRecommendations(input.product, sections, detectedConcepts, input.locale));
  evidence.push(
    { field: "content.productName", source: "input", value: input.product.name },
    { field: "content.description", source: "rag", value: `Description follows target customer + benefits + ingredients/technology + use context + review keywords + evidence. ${input.ragChunks.length} RAG chunks selected.` }
  );
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
    description: sections.description,
    quickFacts: sections.quickFacts,
    faq,
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

function createGeoDescription(product: PdpProductSignal, productName: string, locale: PdpGeoLocale, localizedTerms: string[]): string {
  const targetCustomer = inferTargetCustomer(product, locale);
  const benefit = selectPrimaryBenefit(product, localizedTerms) ?? fallback(locale, {
    "ko-KR": "제품의 핵심 케어",
    "ja-JP": "商品の主要なケア",
    "en-US": "the product's core care benefit",
    "en-GB": "the product's core care benefit"
  });
  const productType = sanitizeCategory(product.category) ?? inferProductType(product) ?? fallback(locale, {
    "ko-KR": "제품",
    "ja-JP": "商品",
    "en-US": "product",
    "en-GB": "product"
  });
  const ingredient = selectKeyIngredients(product, 2).join(", ");
  const usage = first(selectUsageInstructions(product));
  const reviewKeyword = selectReviewKeywords(product).slice(0, 3).join(", ");
  const evidence = selectEvidenceSignal(product);

  switch (locale) {
    case "ko-KR":
      return compactSentence([
        `${productName}은 ${targetCustomer}을 위해 ${benefit}을 강조한 ${productType}입니다`,
        ingredient ? `${truncate(ingredient, 90)} 성분/기술 신호를 함께 제시합니다` : undefined,
        usage ? `${truncate(usage, 90)} 루틴에서 사용하기 좋습니다` : undefined,
        reviewKeyword ? `고객 리뷰에서 반복되는 ${reviewKeyword} 같은 긍정 표현을 반영합니다` : undefined,
        evidence ? `근거 신호: ${truncate(evidence, 80)}` : undefined
      ]);
    case "ja-JP":
      return compactSentence([
        `${productName}は${targetCustomer}に向けて${benefit}を伝える${productType}です`,
        ingredient ? `${truncate(ingredient, 90)}などの成分・技術シグナルを整理します` : undefined,
        usage ? `${truncate(usage, 90)}という使用シーンに合わせて説明します` : undefined,
        reviewKeyword ? `レビューで見られる${reviewKeyword}という好意的な表現も反映します` : undefined,
        evidence ? `根拠シグナル: ${truncate(evidence, 80)}` : undefined
      ]);
    case "en-GB":
    case "en-US":
    default:
      return compactSentence([
        `${productName} is a ${benefit} ${productType} for ${targetCustomer}`,
        ingredient ? `It connects that benefit to ingredient and technology signals such as ${truncate(ingredient, 100)}` : undefined,
        usage ? `It fits routines such as ${truncate(usage, 95)}` : undefined,
        reviewKeyword ? `Review signals highlight ${reviewKeyword}` : undefined,
        evidence ? `Evidence signal: ${truncate(evidence, 90)}` : undefined
      ]);
  }
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
  return first([...localizedTerms, ...selectBenefitSignals(product)].filter(isUsefulBenefitSignal));
}

function selectBenefitSignals(product: PdpProductSignal): string[] {
  return unique([
    ...product.benefits,
    ...product.effects,
    ...selectReviewKeywords(product)
  ].map(cleanSignal).filter(isUsefulBenefitSignal)).slice(0, 10);
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

  return unique([...detected, ...normalized]).slice(0, limit);
}

function selectUsageInstructions(product: PdpProductSignal): string[] {
  const instructions = product.usage
    .map(cleanSignal)
    .filter(isUsageInstruction)
    .sort((a, b) => b.length - a.length);
  const deduped: string[] = [];

  for (const instruction of instructions) {
    const normalized = instruction.toLowerCase();
    if (deduped.some((item) => item.toLowerCase().includes(normalized) || normalized.includes(item.toLowerCase()))) {
      continue;
    }
    deduped.push(instruction.replace(/\bStep\s+\d+\b\.?/gi, "").replace(/\s+/g, " ").trim());
  }

  return deduped.slice(0, 4);
}

function selectReviewKeywords(product: PdpProductSignal): string[] {
  return unique(product.reviews.keywords.map(cleanSignal).filter(isReviewKeyword)).slice(0, 8);
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

function selectEvidenceSignal(product: PdpProductSignal): string | undefined {
  return first([
    ...product.metrics.filter((metric) => /\d/.test(metric)).slice(0, 3),
    product.reviews.rating ? `${product.reviews.rating}${product.reviews.reviewCount ? ` / ${product.reviews.reviewCount} reviews` : " rating"}` : undefined,
    product.description ? truncate(product.description, 90) : undefined
  ]);
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

function createQuickFacts(product: PdpProductSignal, locale: PdpGeoLocale, localizedTerms: string[]): string {
  const facts = [
    labelValue(locale, "Target", inferTargetCustomer(product, locale)),
    labelValue(locale, "Key benefit", selectPrimaryBenefit(product, localizedTerms)),
    labelValue(locale, "Key ingredients", selectKeyIngredients(product, 3).join(", ")),
    labelValue(locale, "Use context", first(selectUsageInstructions(product))),
    labelValue(locale, "Review signals", selectReviewKeywords(product).slice(0, 4).join(", ")),
    labelValue(locale, "Evidence", selectEvidenceSignal(product))
  ].filter((value): value is string => Boolean(value));

  return facts.length > 0 ? facts.join("\n") : fallback(locale, {
    "ko-KR": "입력 상품 JSON에서 확인 가능한 핵심 정보가 부족합니다.",
    "ja-JP": "入力された商品JSONから確認できる主要情報が不足しています。",
    "en-US": "The input product JSON does not include enough quick fact signals.",
    "en-GB": "The input product JSON does not include enough quick fact signals."
  });
}

function createBenefitsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const values = selectBenefitSignals(product).slice(0, 8);
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できるベネフィット情報が十分ではありません。",
    "en-US": "The product JSON does not include enough benefit signals.",
    "en-GB": "The product JSON does not include enough benefit signals."
  });
}

function createIngredientsSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const ingredients = selectKeyIngredients(product, 8);
  return ingredients.length > 0 ? ingredients.map((value) => `- ${value}`).join("\n") : fallback(locale, {
    "ko-KR": "상품 JSON에서 확인된 성분 정보가 충분하지 않습니다.",
    "ja-JP": "商品JSONから確認できる成分情報が十分ではありません。",
    "en-US": "The product JSON does not include enough ingredient signals.",
    "en-GB": "The product JSON does not include enough ingredient signals."
  });
}

function createHowToUseSection(product: PdpProductSignal, locale: PdpGeoLocale): string {
  const usage = selectUsageInstructions(product);
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

function ensureFaq(product: PdpProductSignal, locale: PdpGeoLocale, productName: string): PdpGeoFaqItem[] {
  if (product.faq.length > 0) {
    return product.faq;
  }

  const faq: PdpGeoFaqItem[] = [];
  const usage = first(selectUsageInstructions(product));
  const ingredient = first(selectKeyIngredients(product, 1));
  const benefit = first(selectBenefitSignals(product));

  if (benefit) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `${productName}의 핵심 장점은 무엇인가요?`,
        "ja-JP": `${productName}の主な特徴は何ですか？`,
        "en-US": `What is the main benefit of ${productName}?`,
        "en-GB": `What is the main benefit of ${productName}?`
      }),
      answer: benefit
    });
  }
  if (ingredient) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `주요 성분/기술은 무엇인가요?`,
        "ja-JP": `主な成分・技術は何ですか？`,
        "en-US": "What are the key ingredients or technology signals?",
        "en-GB": "What are the key ingredients or technology signals?"
      }),
      answer: ingredient
    });
  }
  if (usage) {
    faq.push({
      question: fallback(locale, {
        "ko-KR": `어떻게 사용하면 좋나요?`,
        "ja-JP": `どのように使うとよいですか？`,
        "en-US": "How should this product be used?",
        "en-GB": "How should this product be used?"
      }),
      answer: usage
    });
  }

  return faq;
}

function createSchemaMarkup(input: {
  product: PdpProductSignal;
  productName: string;
  description: string;
  quickFacts: string;
  faq: PdpGeoFaqItem[];
  locale: PdpGeoLocale;
  market?: string;
  sourceUrl?: string;
  targets: PdpGeoSchemaTarget[];
}): PdpGeoSchemaMarkup {
  const baseId = input.sourceUrl ?? `urn:agentic-geo:pdp:${slug(input.productName)}`;
  const productId = `${baseId}#product`;
  const webpageId = `${baseId}#webpage`;
  const usageInstructions = selectUsageInstructions(input.product);
  const reviewItems = selectReviewItems(input.product);
  const category = sanitizeCategory(input.product.category) ?? inferProductType(input.product);
  const graph: Array<Record<string, unknown>> = [];

  if (input.targets.includes("WebPage")) {
    graph.push(cleanJson({
      "@type": "WebPage",
      "@id": webpageId,
      url: input.sourceUrl,
      name: input.productName,
      description: input.description,
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
      description: input.description,
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
      additionalProperty: createAdditionalProperties(input.product, input.quickFacts),
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

function createAdditionalProperties(product: PdpProductSignal, quickFacts: string): JsonObject[] {
  const entries: Array<[string, string | undefined]> = [
    ["Quick facts", quickFacts],
    ["Key ingredients", selectKeyIngredients(product, 5).join(", ")],
    ["Use context", first(selectUsageInstructions(product))],
    ["Target concern", first(selectBenefitSignals(product))],
    ["Review signals", selectReviewKeywords(product).slice(0, 5).join(", ")],
    ["Options", product.options.slice(0, 5).join(", ")]
  ];

  return entries.flatMap(([name, value]) => value ? [{
    "@type": "PropertyValue",
    name,
    value
  }] : []);
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

function createRecommendations(product: PdpProductSignal, sections: PdpGeoContentSections, concepts: TerminologyConcept[], locale: PdpGeoLocale): PdpGeoRecommendation[] {
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

  return recommendations;
}

function selectedOfficialDocSources(chunks: PdpGeoRetrievedChunk[]): string[] {
  return Array.from(new Set(
    chunks
      .filter((chunk) => chunk.kind === "official-docs" || /official|openai|google|gemini|perplexity/i.test(`${chunk.source} ${chunk.title ?? ""}`))
      .map((chunk) => chunk.source)
  )).slice(0, 4);
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
    "Review signals": { "ko-KR": "리뷰 신호", "ja-JP": "レビューシグナル", "en-US": "Review signals", "en-GB": "Review signals" },
    Evidence: { "ko-KR": "근거", "ja-JP": "根拠", "en-US": "Evidence", "en-GB": "Evidence" }
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}

function first(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
