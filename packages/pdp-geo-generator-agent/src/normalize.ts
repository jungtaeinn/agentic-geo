import type {
  PdpGeoBreadcrumbItem,
  PdpGeoEvidence,
  PdpGeoFaqItem,
  PdpGeoFieldMapping,
  PdpGeoGenerationHints,
  PdpGeoLocale,
  PdpGeoOcrSentenceDiagnostic,
  PdpGeoOcrSentenceIntent,
  PdpGeoReviewItem,
  PdpProductSignal
} from "./types";

interface NormalizationContext {
  hints?: PdpGeoGenerationHints;
  fieldMapping?: PdpGeoFieldMapping;
  sourceUrl?: string;
}

const fieldCandidates: Record<keyof PdpGeoFieldMapping, string[]> = {
  name: ["geoProduct.name", "product.name", "product.title", "product.productName", "name", "title", "productName", "onlineProdName", "item.name", "item.title"],
  description: ["geoProduct.description", "product.description", "product.body_html", "product.bodyHtml", "description", "body_html", "bodyHtml", "linePromoDesc", "detailDescription", "item.description", "summary"],
  brand: ["geoProduct.brand", "product.brand", "brand", "brand.name", "manufacturer.name", "maker", "vendor"],
  category: ["geoProduct.category", "product.category", "category", "category.name", "productType", "product_type", "item.category"],
  price: ["geoProduct.price.raw", "geoProduct.price", "product.price", "price", "salePrice", "discountedPrice", "onlinePriceInfo.priceInfo.discountedPrice", "variants.0.price", "product.variants.0.price"],
  currency: ["geoProduct.price.currency", "currency", "priceCurrency", "product.currency", "offers.priceCurrency", "onlinePriceInfo.currencyInfo.currencyCode"],
  images: ["geoProduct.images", "product.images", "images", "image", "onlineImages", "media", "photos"],
  options: ["geoProduct.options", "product.options", "options", "variants", "sizes"],
  benefits: ["geoProduct.benefits", "benefits", "product.benefits", "categorizedProductInfo.benefits", "sections.BENEFITS", "sections.benefits"],
  effects: ["geoProduct.effects", "effects", "product.effects", "categorizedProductInfo.effects", "sections.EFFECTS", "sections.effects", "clinicalResults"],
  ingredients: ["geoProduct.ingredients", "ingredients", "keyIngredients", "ingredientHighlights", "categorizedProductInfo.ingredients", "sections.INGREDIENTS", "sections.ingredients"],
  usage: ["geoProduct.usage", "usage", "howToUse", "how_to_use", "directions", "categorizedProductInfo.usage", "sections.HOW TO USE", "sections.howToUse"],
  faq: ["geoProduct.faq", "faq", "faqs", "product.faq", "categorizedProductInfo.faq"],
  reviews: ["geoProduct.reviews.items", "reviews.items", "reviewItems", "reviews", "customerReviewAnalysis.items", "reviewInfo.items"],
  rating: ["geoProduct.reviews.rating", "reviews.rating", "rating", "aggregateRating.ratingValue", "reviewInfo.reviewScope", "customerReviewAnalysis.rating"],
  reviewCount: ["geoProduct.reviews.reviewCount", "reviews.reviewCount", "reviewCount", "aggregateRating.reviewCount", "reviewInfo.reviewCount", "customerReviewAnalysis.reviewCount"],
  breadcrumbs: ["breadcrumbs", "breadcrumb", "breadcrumbList", "categoryPath"]
};

const categoryKeywords = {
  benefit: /benefit|장점|효능|고민|보습|수분|탄력|진정|광채|hydration|moisture|firm|barrier|bright|保湿|うるおい|ハリ|バリア/i,
  effect: /effect|clinical|result|개선|효과|주름|피부결|firmness|wrinkle|elasticity|結果|効果|キメ/i,
  ingredient: /ingredient|성분|원료|전성분|ginseng|retinol|peptide|niacinamide|ceramide|hyaluronic|成分|原料/i,
  usage: /usage|how to use|direction|사용|도포|아침|저녁|apply|morning|night|使い方|使用方法/i,
  review: /review|rating|고객|리뷰|평점|만족|후기|customer|stars|レビュー|評価/i
};

/** Normalizes arbitrary product JSON into the stable internal product signal. */
export function normalizePdpProduct(
  input: unknown,
  context: NormalizationContext = {}
): {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  evidence: PdpGeoEvidence[];
  ocrSentences: PdpGeoOcrSentenceDiagnostic[];
} {
  const source = unwrapProductPayload(input);
  const evidence: PdpGeoEvidence[] = [];
  const mapped = createMappedReader(source, context.fieldMapping, evidence);
  const ocrSentenceInsights = sentenceInsightItems(source);
  const looseFaq = faqFromLooseQuestionAnswerTexts(source);
  const sourceTexts = unique([
    ...ocrSentenceInsights.map((item) => item.text).filter(isUsefulSourceText),
    ...allStrings(source).filter(isUsefulSourceText).slice(0, 80),
    ...mapped.strings("description"),
    ...mapped.strings("benefits"),
    ...mapped.strings("effects"),
    ...mapped.strings("ingredients"),
    ...mapped.strings("usage")
  ].map(cleanSourceSignalText).filter(isUsefulSourceText)).slice(0, 120);

  const name = first([
    ...mapped.strings("name"),
    ...textCandidatesByKey(source, /name|title|상품명|prodName|onlineProdName/i)
  ]) ?? "Untitled product";
  const description = firstLong([
    ...mapped.strings("description"),
    ...textCandidatesByKey(source, /description|desc|summary|body|linePromo/i),
    ...sourceTexts
  ]);
  const brand = context.hints?.brand ?? first([...mapped.strings("brand"), ...textCandidatesByKey(source, /brand|vendor|maker|manufacturer/i)]);
  const category = context.hints?.category ?? first([
    ...mapped.strings("category"),
    ...textCandidatesByKey(source, /categoryName|categoryPath|taxonomy|productType|product_type/i)
  ].filter(isCategorySignal));
  const benefits = normalizeFieldSignals([...mapped.strings("benefits"), ...sentenceInsightTexts(ocrSentenceInsights, "benefit"), ...sectionTexts(source, categoryKeywords.benefit), ...classifiedProductSections(source, "benefit")], "benefit").slice(0, 12);
  const effects = normalizeFieldSignals([...mapped.strings("effects"), ...sentenceInsightTexts(ocrSentenceInsights, "effect"), ...sectionTexts(source, categoryKeywords.effect), ...classifiedProductSections(source, "effect")], "effect").slice(0, 12);
  const ingredients = normalizeFieldSignals([...mapped.strings("ingredients"), ...sentenceInsightTexts(ocrSentenceInsights, "ingredient"), ...sectionTexts(source, categoryKeywords.ingredient), ...classifiedProductSections(source, "ingredient")], "ingredient").slice(0, 14);
  const usage = normalizeFieldSignals([...mapped.strings("usage"), ...sentenceInsightTexts(ocrSentenceInsights, "usage"), ...sectionTexts(source, categoryKeywords.usage), ...classifiedProductSections(source, "usage")], "usage").slice(0, 8);
  const faq = uniqueFaq([...mapped.faq(), ...faqFromUnknown(source), ...looseFaq]).slice(0, 8);
  const reviews = normalizeReviews(source, mapped);
  const images = unique(mapped.strings("images").flatMap((value) => splitPotentialList(value)).map((value) => absolutizeUrl(value, context.sourceUrl))).slice(0, 80);
  const options = unique(mapped.strings("options").flatMap(splitPotentialList)).slice(0, 16);
  const priceRaw = first(mapped.strings("price"));
  const metrics = unique(sourceTexts.flatMap(extractMetricPhrases)).slice(0, 20);
  const breadcrumbs = normalizeBreadcrumbs(mapped.values("breadcrumbs"), {
    brand,
    category,
    name,
    url: context.sourceUrl
  });
  const locale = context.hints?.locale ?? inferLocale([name, description, ...sourceTexts].join("\n"));
  const market = context.hints?.market ?? defaultMarketForLocale(locale);
  const ocrSentences = createOcrSentenceDiagnostics(ocrSentenceInsights, locale);

  const product: PdpProductSignal = {
    name,
    originalName: name,
    description,
    brand,
    category,
    price: priceRaw ? {
      raw: priceRaw,
      amount: priceAmount(priceRaw),
      currency: first(mapped.strings("currency"))
    } : undefined,
    images,
    options,
    benefits,
    effects,
    ingredients,
    usage,
    metrics,
    faq,
    reviews,
    breadcrumbs,
    sourceTexts
  };

  evidence.push({ field: "product.name", source: "input", value: name });
  if (description) {
    evidence.push({ field: "product.description", source: "input", value: description });
  }
  if (reviews.keywords.length > 0) {
    evidence.push({ field: "reviews.keywords", source: "input", value: reviews.keywords.slice(0, 8).join(", ") });
  }
  if (ocrSentences.length > 0) {
    evidence.push({ field: "ocr.sentences", source: "input", value: `${ocrSentences.length} OCR sentences classified by intent for schema composition.` });
  }

  return {
    product,
    locale,
    market,
    evidence,
    ocrSentences
  };
}

function unwrapProductPayload(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  if (isRecord(input.geoProduct)) {
    return input.geoProduct;
  }
  if (isRecord(input.result) && isRecord(input.result.geoProduct)) {
    return input.result.geoProduct;
  }
  if (isRecord(input.product)) {
    return {
      ...input,
      ...input.product
    };
  }

  return input;
}

function createMappedReader(source: unknown, fieldMapping: PdpGeoFieldMapping | undefined, evidence: PdpGeoEvidence[]) {
  function configuredPaths(field: keyof PdpGeoFieldMapping): string[] {
    const configured = fieldMapping?.[field];
    const configuredArray = Array.isArray(configured) ? configured : configured ? [configured] : [];
    return [...configuredArray, ...(fieldCandidates[field] ?? [])];
  }

  function values(field: keyof PdpGeoFieldMapping): unknown[] {
    const results: unknown[] = [];
    for (const path of configuredPaths(field)) {
      const value = getByPath(source, path);
      if (value !== undefined) {
        results.push(value);
        if (fieldMapping?.[field] && path === (Array.isArray(fieldMapping[field]) ? fieldMapping[field]?.[0] : fieldMapping[field])) {
          evidence.push({ field: String(field), source: "fieldMapping", value: path });
        }
      }
    }
    return results;
  }

  function strings(field: keyof PdpGeoFieldMapping): string[] {
    return unique(values(field).flatMap(flattenTextValues).map(cleanText).filter(Boolean));
  }

  function faq(): PdpGeoFaqItem[] {
    return values("faq").flatMap(faqFromUnknown);
  }

  return {
    values,
    strings,
    faq
  };
}

function normalizeReviews(source: unknown, mapped: ReturnType<typeof createMappedReader>): PdpProductSignal["reviews"] {
  const items = uniqueReviewItems([
    ...mapped.values("reviews").flatMap(readReviewItems),
    ...readReviewItems(getByPath(source, "customerReviewAnalysis.items")),
    ...reviewSummaries(source).map((body) => ({ body }))
  ]).slice(0, 12);
  const keywordCandidates = unique([
    ...textCandidatesByKey(source, /keywords?|키워드/i),
    ...mapped.values("reviews").flatMap(flattenTextValues).flatMap(extractReviewKeywords),
    ...flattenTextValues(getByPath(source, "geoProduct.reviews.keywords")),
    ...flattenTextValues(getByPath(source, "reviews.keywords")),
    ...flattenTextValues(getByPath(source, "customerReviewAnalysis.keywords")),
    ...items.flatMap((item) => extractReviewKeywords(item.body))
  ]);
  const keywords = unique(keywordCandidates
    .filter((keyword) => isReviewKeyword(keyword) || isPotentialReviewKeywordCandidate(keyword)))
    .slice(0, 16);
  const rating = firstNumber([...mapped.values("rating"), getByPath(source, "reviews.rating"), getByPath(source, "customerReviewAnalysis.rating")]);
  const reviewCount = firstNumber([...mapped.values("reviewCount"), getByPath(source, "reviews.reviewCount"), getByPath(source, "customerReviewAnalysis.reviewCount")]);

  return {
    rating,
    reviewCount,
    items,
    keywords
  };
}

function readReviewItems(value: unknown): PdpGeoReviewItem[] {
  const values = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return values.flatMap((item): PdpGeoReviewItem[] => {
    if (typeof item === "string") {
      return [{ body: cleanText(item) }].filter((review) => review.body.length > 0);
    }
    if (!isRecord(item)) {
      return [];
    }
    const body = first([
      stringValue(item.body),
      stringValue(item.reviewBody),
      stringValue(item.text),
      stringValue(item.content),
      stringValue(item.comment),
      stringValue(item.longSummary),
      stringValue(item.shortSummary)
    ]);
    if (!body) {
      return [];
    }
    return [{
      body,
      author: stringValue(item.author) ?? (isRecord(item.author) ? stringValue(item.author.name) : undefined),
      rating: numberValue(item.rating) ?? (isRecord(item.reviewRating) ? numberValue(item.reviewRating.ratingValue) : undefined),
      datePublished: stringValue(item.datePublished) ?? stringValue(item.createdAt)
    }];
  });
}

function reviewSummaries(source: unknown): string[] {
  return unique([
    ...textCandidatesByKey(source, /reviewSignal|reviewSignals|ratingSummary|shortSummary|longSummary|reviewSummary|customerReview/i),
    ...sectionTexts(source, categoryKeywords.review)
  ]).slice(0, 8);
}

function faqFromUnknown(value: unknown): PdpGeoFaqItem[] {
  const candidates = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  const direct = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : candidates;

  return direct.flatMap((item): PdpGeoFaqItem[] => {
    if (!isRecord(item)) {
      return [];
    }
    const question = first([
      stringValue(item.question),
      stringValue(item.q),
      stringValue(item.name),
      stringValue(item.title)
    ]);
    const answer = first([
      stringValue(item.answer),
      stringValue(item.a),
      stringValue(item.text),
      stringValue(item.acceptedAnswer),
      isRecord(item.acceptedAnswer) ? stringValue(item.acceptedAnswer.text) : undefined
    ]);
    return question && answer ? [{ question, answer }] : [];
  });
}

function normalizeBreadcrumbs(values: unknown[], fallback: { brand?: string; category?: string; name: string; url?: string }): PdpGeoBreadcrumbItem[] {
  const items = values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.flatMap(readBreadcrumbItem);
    }
    return readBreadcrumbItem(value);
  });
  const fallbackItems = [
    fallback.brand ? { name: fallback.brand } : undefined,
    fallback.category ? { name: fallback.category } : undefined,
    { name: fallback.name, url: fallback.url }
  ].filter((item): item is PdpGeoBreadcrumbItem => Boolean(item));

  return uniqueBreadcrumbs(items.length > 0 ? items : fallbackItems).slice(0, 6);
}

function readBreadcrumbItem(value: unknown): PdpGeoBreadcrumbItem[] {
  if (typeof value === "string") {
    return value.split(/[>/|]/).map((name) => ({ name: cleanText(name) })).filter((item) => item.name.length > 0);
  }
  if (!isRecord(value)) {
    return [];
  }
  const name = first([stringValue(value.name), stringValue(value.title), stringValue(value.label)]);
  return name ? [{ name, url: stringValue(value.url) ?? stringValue(value.href) ?? stringValue(value.item) }] : [];
}

function classifiedProductSections(source: unknown, category: "benefit" | "effect" | "ingredient" | "usage"): string[] {
  const sections = getByPath(source, "contentAnalysis.sections") ?? getByPath(source, "aiAnalysis.categorizedSections") ?? getByPath(source, "sourceExtraction.html.sections");
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.flatMap((section) => {
    if (!isRecord(section) || section.category !== category) {
      return [];
    }
    return flattenTextValues([section.text, section.body, section.bullets]).filter((text) => text.length > 0);
  });
}

type ProductSignalField = "benefit" | "effect" | "ingredient" | "usage";

function normalizeFieldSignals(values: string[], field: ProductSignalField): string[] {
  return unique(values
    .map(cleanSourceSignalText)
    .filter((value) => isAllowedFieldSignal(value, field)));
}

function isAllowedFieldSignal(value: string, field: ProductSignalField): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || !isUsefulSourceText(text) || isQuestionLikeSourceText(text)) {
    return false;
  }

  if (field === "usage") {
    return isUsageInstruction(text);
  }
  if (field === "ingredient") {
    return isIngredientSignal(text);
  }
  if (field === "benefit") {
    return isConciseBenefitSignal(text);
  }
  return isEffectSignal(text);
}

function isUsefulSourceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length < 2 || text.length > 700 || isUrlLikeText(text) || isOcrFootnote(text)) {
    return false;
  }
  return /[A-Za-z가-힣]/.test(text);
}

function cleanSourceSignalText(value: string): string {
  if (isUrlLikeText(value)) {
    return cleanText(value);
  }
  return cleanText(value)
    .replace(/([.!?。！？])(?=[가-힣A-Z])/g, "$1 ")
    .replace(/\s+([,.!?。！？])/g, "$1")
    .trim();
}

function isQuestionLikeSourceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text) {
    return false;
  }
  if (/[?？]\s*$/.test(text)) {
    return true;
  }
  return /(?:무엇|뭐|어떤|어떻게|왜|언제|어디|누가|가능|괜찮|되나|되나요|인가요|있나요|해주는\s*것인가요|할까요|좋나요)\s*$/.test(text)
    || /^(?:what|how|why|when|where|who|which|can|does|do|is|are)\b/i.test(text);
}

function isConciseBenefitSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length > 90 || /[.。]/.test(text) || isBrokenSourceFragment(text)) {
    return false;
  }
  return /benefit|hydration|moisture|firm|elastic|barrier|bright|soothing|comfort|wrinkle|fine lines?|plump|lifting|수분|보습|장벽|탄력|진정|피부결|쿨링|붉은기|저자극|속수분|유수분|保湿|うるおい|ハリ|バリア/i.test(text);
}

function isEffectSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length > 320) {
    return false;
  }
  return /effect|clinical|result|improve|supports?|hydration|moisture|barrier|soothing|firm|elastic|texture|cooling|sebum|효과|효능|개선|수분|보습|장벽|진정|탄력|피부결|쿨링|피지|유분|속수분|유수분|保湿|効果|キメ/i.test(text);
}

function isIngredientSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length > 360) {
    return false;
  }
  if (/^(성분|원료|ingredient|ingredients)$/i.test(text)) {
    return false;
  }
  return /ingredients?|active|actives?|formula|technology|tech|전성분|성분표|히알루론산|하이알루론산|세라마이드|징크|zinc|dermaon|ha\b|캡슐|ceramide|hyaluronic|retinol|niacinamide|peptide|ginseng|panthenol|aqua|glycerin/i.test(text);
}

function isBrokenSourceFragment(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  return openParens !== closeParens
    || /리뉴얼\s*전\s*제품에서\s*고객님들이\s*만족|고객님들이\s*만족하셨던\s*속성|속성\s*\(/.test(text);
}

function faqFromLooseQuestionAnswerTexts(source: unknown): PdpGeoFaqItem[] {
  const texts = allStrings(source)
    .map(cleanSourceSignalText)
    .filter(isUsefulSourceText)
    .filter((text) => text.length <= 500);
  const items: PdpGeoFaqItem[] = [];

  for (let index = 0; index < texts.length; index += 1) {
    const question = texts[index];
    if (!question || !isQuestionLikeSourceText(question) || question.length > 140) {
      continue;
    }

    const answer = texts
      .slice(index + 1, index + 4)
      .find((candidate) => !isQuestionLikeSourceText(candidate) && isLikelyFaqAnswer(candidate));
    if (answer) {
      items.push({ question, answer });
    }
  }

  return uniqueFaq(items);
}

function isLikelyFaqAnswer(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length < 18 || isUrlLikeText(text)) {
    return false;
  }
  return /[.!。]|입니다|습니다|해요|합니다|됩니다|권장|완료|함유|설계|개선|효과|테스트|contains?|includes?|supports?|helps?|recommended|completed/i.test(text);
}

type OcrSentenceCategory = PdpGeoOcrSentenceIntent;

interface OcrSentenceInsightInput {
  text: string;
  category: OcrSentenceCategory;
  keywords: string[];
}

function sentenceInsightItems(source: unknown): OcrSentenceInsightInput[] {
  return uniqueSentenceInsights([
    ...readSentenceInsights(getByPath(source, "sourceExtraction.ocr.sentenceInsights")),
    ...readSentenceInsights(getByPath(source, "ocr.sentenceInsights")),
    ...readSentenceInsights(getByPath(source, "aiAnalysis.sentenceInsights")),
    ...readOcrTextInsights(source)
  ]);
}

function readSentenceInsights(value: unknown): OcrSentenceInsightInput[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item): OcrSentenceInsightInput[] => {
    if (!isRecord(item)) {
      return [];
    }
    const text = stringValue(item.text);
    const category = stringValue(item.category);
    const keywords = flattenTextValues(item.keywords).slice(0, 10);

    if (!text) {
      return [];
    }

    return inferOcrSentenceCategories(text, keywords, category).map((inferredCategory) => ({
      text,
      category: inferredCategory,
      keywords
    }));
  });
}

function sentenceInsightTexts(items: OcrSentenceInsightInput[], category: "benefit" | "effect" | "ingredient" | "usage"): string[] {
  return items
    .filter((item) => item.category === category)
    .map((item) => item.text)
    .filter((text) => text.length > 0);
}

function uniqueSentenceInsights(items: OcrSentenceInsightInput[]): OcrSentenceInsightInput[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.category}:${item.text.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return item.text.length > 0;
  });
}

function createOcrSentenceDiagnostics(items: OcrSentenceInsightInput[], locale: PdpGeoLocale): PdpGeoOcrSentenceDiagnostic[] {
  const grouped = new Map<string, { text: string; intents: OcrSentenceCategory[] }>();

  for (const item of items) {
    const key = item.text.toLowerCase();
    const existing = grouped.get(key) ?? { text: item.text, intents: [] };
    existing.intents = uniqueCategories([...existing.intents, item.category]);
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map((item) => ({
      text: item.text,
      intents: item.intents,
      schemaFields: schemaFieldsForOcrIntents(item.intents),
      geoUse: geoUseForOcrSentence(item.intents, locale)
    }))
    .filter((item) => item.intents.length > 0 && item.schemaFields.length > 0)
    .slice(0, 80);
}

function schemaFieldsForOcrIntents(intents: OcrSentenceCategory[]): string[] {
  const fields: string[] = [];
  if (intents.includes("ingredient")) {
    fields.push("Product.additionalProperty[Key ingredients]", "Product.description", "content.sections.ingredients");
  }
  if (intents.includes("effect") || intents.includes("benefit")) {
    fields.push("Product.description", "WebPage.description", "content.sections.benefits", "FAQPage.mainEntity");
  }
  if (intents.includes("usage")) {
    fields.push("HowTo.step", "content.sections.howToUse");
  }
  if (intents.includes("review")) {
    fields.push("Review.reviewBody", "Product.positiveNotes", "FAQPage.mainEntity");
  }
  return unique(fields);
}

function geoUseForOcrSentence(intents: OcrSentenceCategory[], _locale: PdpGeoLocale): string {
  const hasIngredient = intents.includes("ingredient");
  const hasBenefit = intents.includes("benefit") || intents.includes("effect");
  const hasUsage = intents.includes("usage");
  const hasReview = intents.includes("review");

  if (hasIngredient && hasBenefit) {
    return "ingredient_effect_evidence";
  }
  if (hasIngredient) {
    return "ingredient_evidence";
  }
  if (hasBenefit) {
    return "benefit_effect_evidence";
  }
  if (hasUsage) {
    return "usage_routine_evidence";
  }
  if (hasReview) {
    return "review_experience_evidence";
  }
  return "semantic_ocr_evidence";
}

function readOcrTextInsights(source: unknown): OcrSentenceInsightInput[] {
  return ocrTextCandidates(source).flatMap((text) => inferOcrSentenceCategories(text).map((category) => ({
    text,
    category,
    keywords: extractOcrKeywords(text)
  })));
}

function ocrTextCandidates(source: unknown): string[] {
  const roots = [
    getByPath(source, "sourceExtraction.ocr"),
    getByPath(source, "sourceExtraction.images"),
    getByPath(source, "ocr"),
    getByPath(source, "images"),
    getByPath(source, "aiAnalysis.ocr")
  ].filter((value) => value !== undefined);

  return unique(roots
    .flatMap(readOcrTextsFromNode)
    .flatMap(splitOcrTextIntoSemanticSentences)
    .map(cleanOcrSentence)
    .filter(isUsefulOcrSentence))
    .slice(0, 80);
}

function readOcrTextsFromNode(value: unknown): string[] {
  const results: string[] = [];

  visit(value, (node, key) => {
    if (Array.isArray(node) && key && /lines?|blocks?|paragraphs?|sentences?|textBlocks?/i.test(key)) {
      const joined = flattenTextValues(node)
        .filter((text) => !isUrlLikeText(text))
        .join("\n");
      if (joined) {
        results.push(joined);
      }
      return;
    }
    if (typeof node !== "string") {
      return;
    }
    const text = cleanOcrRawText(htmlToText(node));
    if (!text || isUrlLikeText(text)) {
      return;
    }
    if (!key || /(?:text|ocr|line|block|paragraph|sentence|caption|description|body|fullText|rawText|recognizedText|copy)/i.test(key) || text.includes("\n")) {
      results.push(text);
    }
  });

  return results;
}

function cleanOcrRawText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\n")) {
    return cleanText(normalized);
  }
  return normalized
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function splitOcrTextIntoSemanticSentences(value: string): string[] {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean)
    .filter((line) => !isOcrFootnote(line));

  if (lines.length <= 1) {
    return splitOcrSentenceByPunctuation(value);
  }

  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (current.length > 0 && isOcrBlockHeadingAt(lines, index) && current.length >= 2) {
      flush();
    }
    current.push(line);
    if (/[.!?。！？]$/.test(line)) {
      flush();
    }
  }
  flush();

  return blocks.flatMap((block) => {
    const joined = joinOcrBlock(block);
    return hasOcrHeadingBody(block) ? [joined] : splitOcrSentenceByPunctuation(joined);
  });
}

function splitOcrSentenceByPunctuation(value: string): string[] {
  const text = cleanText(value);
  if (!text) {
    return [];
  }
  const parts = text.split(/(?<=[.!?。！？])\s+/).map(cleanText).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

function joinOcrBlock(block: string[]): string {
  const headingCount = countLeadingOcrHeadingLines(block);
  if (headingCount > 0 && headingCount < block.length) {
    const heading = block.slice(0, headingCount).join(" ");
    const body = block.slice(headingCount).join(" ");
    return body ? `${trimTrailingSentencePunctuation(heading)}. ${body}` : heading;
  }
  return block.join(" ");
}

function hasOcrHeadingBody(block: string[]): boolean {
  const headingCount = countLeadingOcrHeadingLines(block);
  return headingCount > 0 && headingCount < block.length;
}

function countLeadingOcrHeadingLines(block: string[]): number {
  if (block.length <= 1 || !isOcrHeadingCandidate(block[0] ?? "")) {
    return 0;
  }

  let count = 1;
  while (count < block.length - 1) {
    const line = block[count] ?? "";
    if (!isOcrHeadingCandidate(line) || isOcrBodyContinuationLine(line)) {
      break;
    }
    count += 1;
  }

  return count;
}

function isOcrBlockHeadingAt(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1];
  if (!isOcrHeadingCandidate(line) || !next) {
    return false;
  }
  return isOcrBodyContinuationLine(next) || Boolean(lines[index + 2] && isOcrBodyContinuationLine(lines[index + 2] ?? ""));
}

function isOcrHeadingCandidate(value: string): boolean {
  const text = cleanText(value);
  if (!text || text.length > 36 || /[.!?。！？]$/.test(text)) {
    return false;
  }
  if (!/[A-Za-z가-힣]/.test(text) || isOcrBodyContinuationLine(text)) {
    return false;
  }
  return text.split(/\s+/).length <= 5;
}

function isOcrBodyContinuationLine(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }
  if (looksLikeEnglishTitleLine(text)) {
    return false;
  }
  if (/[.!?。！？]$/.test(text)) {
    return true;
  }
  if (/[가-힣]/.test(text)) {
    return /(?:기술로|징크로|세라마이드로|성분으로|구조의|캡슐로|길이가|롱체인|연결고리|조여|보완|채워|맞추|효과|컨트롤|보습|개선|충전|흡수|피지|과잉|민감피부|부족한|피부의|피부\s|수분|장벽)/.test(text);
  }
  return /\b(?:is|are|was|were|helps?|supports?|combines?|enhances?|absorbs?|controls?|provides?|delivers?|working|for|by|that|and|of|to|from|with)\b/i.test(text)
    || /\b(?:patented|fast|rapid|skin|moisture|barrier|sebum|control|hydration|lasting|formula|technology)\b/i.test(text);
}

function looksLikeEnglishTitleLine(value: string): boolean {
  const words = cleanText(value)
    .split(/\s+/)
    .filter((word) => /[A-Za-z]/.test(word));
  if (words.length === 0 || words.length > 6) {
    return false;
  }
  const titleWords = words.filter((word) => {
    const normalized = word.replace(/[^A-Za-z]/g, "");
    return normalized.length <= 2 || /^[A-Z]/.test(normalized);
  });
  return titleWords.length / words.length >= 0.65;
}

function trimTrailingSentencePunctuation(value: string): string {
  return cleanText(value).replace(/[.!?。！？]+$/g, "").trim();
}

function cleanOcrSentence(value: string): string {
  return cleanText(value)
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([가-힣])\s+([™®])/g, "$1$2")
    .trim();
}

function isUsefulOcrSentence(value: string): boolean {
  const text = cleanText(value);
  if (text.length < 8 || text.length > 700 || isUrlLikeText(text) || isOcrFootnote(text)) {
    return false;
  }
  if (/^\d+(?:\.\d+)?\s*(?:ml|mL|oz|fl\.?\s*oz)$/i.test(text)) {
    return false;
  }
  return /[A-Za-z가-힣]/.test(text);
}

function isOcrFootnote(value: string): boolean {
  return /^\s*[*※]/.test(value.trim()) || /원료적\s*특성에\s*한함/.test(value);
}

function isUrlLikeText(value: string): boolean {
  return /^(?:https?:\/\/|data:image\/|\/)/i.test(value.trim()) || /\.(?:jpe?g|png|webp|gif|avif|svg)(?:\?|$)/i.test(value.trim());
}

function inferOcrSentenceCategories(text: string, keywords: string[] = [], explicitCategory?: string): OcrSentenceCategory[] {
  const haystack = `${text} ${keywords.join(" ")}`;
  const explicit = normalizeOcrCategory(explicitCategory);
  const categories: OcrSentenceCategory[] = explicit ? [explicit] : [];

  if (/ingredients?|ingredient|active|actives?|formula|technology|tech|성분|원료|전성분|기술|히알루론산|하이알루론산|세라마이드|징크|zinc|dermaon|ha\b|캡슐|ceramide|hyaluronic|retinol|niacinamide|peptide|ginseng|panthenol/i.test(haystack)) {
    categories.push("ingredient");
  }
  if (/benefit|hydration|moisture|barrier|soothing|refreshing|firm|elastic|texture|comfort|oil|sebum|효능|효과|수분|속수분|보습|장벽|피지|유분|유수분|흡수|지속|컨트롤|밸런스|진정|탄력|피부결|산뜻|쿨링/i.test(haystack)) {
    categories.push("effect");
    categories.push("benefit");
  }
  if (/sensitive|oily|dry|combination|민감|지성|건성|피부|skin/i.test(haystack) && /수분|보습|barrier|hydration|moisture|soothing|oil|sebum|밸런스|balance/i.test(haystack)) {
    categories.push("benefit");
  }
  if (/apply|use|massage|morning|night|사용|도포|바르|흡수|루틴/i.test(haystack)) {
    categories.push("usage");
  }
  if (/review|customer|rating|리뷰|후기|평점|만족/i.test(haystack)) {
    categories.push("review");
  }

  return uniqueCategories(categories);
}

function normalizeOcrCategory(value?: string): OcrSentenceCategory | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/ingredient|active|formula|technology|성분|원료/.test(normalized)) {
    return "ingredient";
  }
  if (/effect|efficacy|result|효능|효과/.test(normalized)) {
    return "effect";
  }
  if (/benefit|concern|target|장점|고민|피부/.test(normalized)) {
    return "benefit";
  }
  if (/usage|direction|how|사용/.test(normalized)) {
    return "usage";
  }
  if (/review|rating|customer|리뷰|후기/.test(normalized)) {
    return "review";
  }
  return undefined;
}

function extractOcrKeywords(text: string): string[] {
  const keywords = [
    /압축\s*히알루론산/i.test(text) ? "압축 히알루론산" : undefined,
    /히알루론산|하이알루론산/i.test(text) ? "히알루론산" : undefined,
    /징크|zinc/i.test(text) ? "징크" : undefined,
    /고밀도\s*세라마이드\s*캡슐/i.test(text) ? "고밀도 세라마이드 캡슐" : undefined,
    /세라마이드/i.test(text) ? "세라마이드" : undefined,
    /dermaon/i.test(text) ? "DermaON" : undefined,
    /수분|hydration|moisture/i.test(text) ? "수분감" : undefined,
    /장벽|barrier/i.test(text) ? "피부 장벽" : undefined,
    /피지|유분|sebum|oil/i.test(text) ? "유분 컨트롤" : undefined
  ].filter((value): value is string => Boolean(value));
  return unique(keywords).slice(0, 10);
}

function uniqueCategories(values: OcrSentenceCategory[]): OcrSentenceCategory[] {
  return Array.from(new Set(values));
}

function sectionTexts(source: unknown, pattern: RegExp): string[] {
  const results: string[] = [];
  visit(source, (value, key) => {
    if (!key || !pattern.test(key)) {
      return;
    }
    results.push(...flattenTextValues(value));
  });
  return unique(results.map(cleanText).filter((value) => value.length > 0));
}

function textCandidatesByKey(source: unknown, pattern: RegExp): string[] {
  const results: string[] = [];
  visit(source, (value, key) => {
    if (key && pattern.test(key)) {
      results.push(...flattenTextValues(value));
    }
  });
  return unique(results.map(cleanText).filter((value) => value.length > 0));
}

function allStrings(value: unknown): string[] {
  const results: string[] = [];
  visit(value, (node) => {
    if (typeof node === "string") {
      results.push(cleanText(htmlToText(node)));
    }
  });
  return results.filter((text) => text.length > 0);
}

function visit(value: unknown, callback: (value: unknown, key?: string) => void, key?: string, depth = 0) {
  if (depth > 8) {
    return;
  }
  callback(value, key);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, String(index), depth + 1));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, callback, childKey, depth + 1));
  }
}

function getByPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = value;
  for (const part of parts) {
    if (isRecord(current)) {
      current = current[part];
    } else if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      return undefined;
    }
  }
  return current;
}

function flattenTextValues(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [cleanText(htmlToText(String(value)))].filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenTextValues);
  }
  if (!isRecord(value)) {
    return [];
  }

  if (typeof value.src === "string") {
    return [value.src];
  }
  if (typeof value.url === "string" && Object.keys(value).length <= 3) {
    return [value.url];
  }
  if (typeof value.imgUrl === "string") {
    return [value.imgUrl];
  }
  if (typeof value.name === "string" && Object.keys(value).length <= 3) {
    return [value.name];
  }
  if (typeof value.value === "string") {
    return [value.value];
  }
  if (typeof value.text === "string") {
    return [value.text];
  }

  return Object.values(value).flatMap(flattenTextValues);
}

function inferLocale(text: string): PdpGeoLocale {
  if (/[ぁ-んァ-ン一-龯]/.test(text) && /[ぁ-んァ-ン]/.test(text)) {
    return "ja-JP";
  }
  if (/[가-힣]/.test(text)) {
    return "ko-KR";
  }
  return "en-US";
}

function defaultMarketForLocale(locale: PdpGeoLocale): string {
  switch (locale) {
    case "ko-KR":
      return "KR";
    case "ja-JP":
      return "JP";
    case "en-GB":
      return "GB";
    case "en-US":
    default:
      return "US";
  }
}

function splitPotentialList(value: string): string[] {
  if (/^https?:\/\//i.test(value) || value.startsWith("/")) {
    return [value];
  }
  return value.split(/\n|,| \| | \/ /).map(cleanText).filter(Boolean);
}

function absolutizeUrl(value: string, base?: string): string {
  if (!value || /^https?:\/\//i.test(value) || !base) {
    return value;
  }
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function extractMetricPhrases(text: string): string[] {
  return Array.from(text.matchAll(/\b\d+(?:\.\d+)?\s?(?:%|ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|점|개|명|회|주|일|시간|パーセント|週間|日間)\b/gi))
    .map((match) => match[0]);
}

function extractReviewKeywords(text: string): string[] {
  return unique(text
    .split(/[\s,./|·()[\]{}<>:;!?]+/)
    .map(cleanText)
    .filter((term) => term.length >= 2)
    .filter((term) => /보습|흡수|탄력|피부결|순한|만족|촉촉|texture|hydration|moisture|firm|lightweight|rich|absorbs|うるおい|保湿|ハリ|なじみ|満足/i.test(term)))
    .slice(0, 12);
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function first(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function firstLong(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value && value.length >= 20)) ?? first(values);
}

function firstNumber(values: unknown[]): number | undefined {
  return values.map(numberValue).find((value): value is number => typeof value === "number");
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return cleanText(htmlToText(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]+/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function priceAmount(value: string): number | undefined {
  const parsed = Number(value.replace(/[^\d.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function uniqueFaq(values: PdpGeoFaqItem[]): PdpGeoFaqItem[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.question}\n${item.answer}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return item.question.length > 0 && item.answer.length > 0;
  });
}

function uniqueReviewItems(values: PdpGeoReviewItem[]): PdpGeoReviewItem[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.body.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return isMeaningfulReviewBody(item.body);
  });
}

function isCategorySignal(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 60) {
    return false;
  }

  return !/^(usage|use|how to use|direction|directions|review|reviews|rating|ratings|benefit|benefits|effect|effects|ingredient|ingredients|image|images|content|section|product|item|type)$/i.test(normalized);
}

function isUsageInstruction(value: string): boolean {
  const normalized = cleanSourceSignalText(value);
  if (normalized.length < 18 || normalized.length > 260) {
    return false;
  }
  if (normalized.split(/\s+/).length < 4) {
    return false;
  }
  if (isQuestionLikeSourceText(normalized) || /사용\s*적합|테스트를\s*완료|임산부|영유아|어린이|논코메도제닉/i.test(normalized)) {
    return false;
  }

  return /apply|warm|massage|cup|pat|layer|morning|night|routine|step|after|before|아침|저녁|단계|얼굴|도포|바르|펴\s*바르|흡수|루틴|朝|夜|なじませ|塗布/i.test(normalized);
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

function isPotentialReviewKeywordCandidate(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 12) {
    return false;
  }
  if (!/^[가-힣\s]+$/.test(normalized)) {
    return false;
  }
  if (/^(리뷰|후기|평점|별점|고객|키워드|성분|제품|상품|옵션)$/i.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length <= 3;
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

function uniqueBreadcrumbs(values: PdpGeoBreadcrumbItem[]): PdpGeoBreadcrumbItem[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return item.name.length > 0;
  });
}
