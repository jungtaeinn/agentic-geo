import type {
  PdpGeoBreadcrumbItem,
  PdpGeoEvidence,
  PdpGeoFaqItem,
  PdpGeoFieldMapping,
  PdpGeoGenerationHints,
  PdpGeoLocale,
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
} {
  const source = unwrapProductPayload(input);
  const evidence: PdpGeoEvidence[] = [];
  const mapped = createMappedReader(source, context.fieldMapping, evidence);
  const sourceTexts = unique([
    ...allStrings(source).filter((value) => value.length >= 8).slice(0, 80),
    ...mapped.strings("description"),
    ...mapped.strings("benefits"),
    ...mapped.strings("effects"),
    ...mapped.strings("ingredients"),
    ...mapped.strings("usage")
  ]).slice(0, 120);

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
  const benefits = unique([...mapped.strings("benefits"), ...sectionTexts(source, categoryKeywords.benefit), ...classifiedProductSections(source, "benefit")]).slice(0, 12);
  const effects = unique([...mapped.strings("effects"), ...sectionTexts(source, categoryKeywords.effect), ...classifiedProductSections(source, "effect")]).slice(0, 12);
  const ingredients = unique([...mapped.strings("ingredients"), ...sectionTexts(source, categoryKeywords.ingredient), ...classifiedProductSections(source, "ingredient")]).slice(0, 14);
  const usage = unique([...mapped.strings("usage"), ...sectionTexts(source, categoryKeywords.usage), ...classifiedProductSections(source, "usage")]).filter(isUsageInstruction).slice(0, 8);
  const faq = uniqueFaq([...mapped.faq(), ...faqFromUnknown(source)]).slice(0, 8);
  const reviews = normalizeReviews(source, mapped);
  const images = unique(mapped.strings("images").flatMap((value) => splitPotentialList(value)).map((value) => absolutizeUrl(value, context.sourceUrl))).slice(0, 12);
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

  return {
    product,
    locale,
    market,
    evidence
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
  const keywords = unique([
    ...textCandidatesByKey(source, /keywords?|키워드/i),
    ...mapped.values("reviews").flatMap(flattenTextValues).flatMap(extractReviewKeywords),
    ...flattenTextValues(getByPath(source, "geoProduct.reviews.keywords")),
    ...flattenTextValues(getByPath(source, "reviews.keywords")),
    ...flattenTextValues(getByPath(source, "customerReviewAnalysis.keywords")),
    ...items.flatMap((item) => extractReviewKeywords(item.body))
  ]).filter(isReviewKeyword).slice(0, 16);
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
  const normalized = value.trim();
  if (normalized.length < 18 || normalized.length > 260) {
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
