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
  PdpProductSignal,
  PdpSemanticFacts,
  PdpSemanticCitation,
  PdpSemanticIngredientBenefitLink,
  PdpSemanticMetricClaim
} from "./types";
import { filterCurrentProductUsageInstructions } from "./product-scope";

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
  // Match review containers as semantic keys, not as arbitrary substrings.
  // In particular, OCR fields such as `textPreview` must never become review
  // evidence merely because "preview" contains the letters "review".
  review: /^(?:reviews?|reviewItems?|reviewSignals?|reviewSummary|rating|ratingSummary|customerReviews?|customerReviewAnalysis|stars?)$|(?:고객|리뷰|평점|만족|후기)|レビュー|評価/i
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
  const name = first([
    ...mapped.strings("name"),
    ...textCandidatesByKey(source, /name|title|상품명|prodName|onlineProdName/i)
  ]) ?? "Untitled product";
  const semanticFacts = normalizeSemanticFacts(source, ocrSentenceInsights, name);
  const looseFaq = faqFromLooseQuestionAnswerTexts(source);
  const sourceTexts = unique([
    ...ocrSentenceInsights.map((item) => item.text).filter(isUsefulSourceText),
    ...textArray(getByPath(source, "sourceTexts")),
    ...textArray(getByPath(source, "geoProduct.sourceTexts")),
    ...textArray(getByPath(source, "sourceExtraction.ocr.textBlocks")),
    ...allStrings(source).filter(isUsefulSourceText).slice(0, 80),
    ...mapped.strings("description"),
    ...mapped.strings("benefits"),
    ...mapped.strings("effects"),
    ...mapped.strings("ingredients"),
    ...mapped.strings("usage")
  ].map(cleanSourceSignalText).filter(isUsefulSourceText)).slice(0, 120);

  // An explicitly routed description is authoritative even when it is short.
  // Falling through to an arbitrary longer `body` used to let nested review
  // copy replace valid product descriptions such as "A face serum.".
  const mappedDescriptions = mapped.strings("description");
  const description = first(mappedDescriptions) ?? firstLong(
    textCandidatesByKeyOutsideReview(source, /description|desc|summary|linePromo/i)
  );
  const inferredBrand = first([...mapped.strings("brand"), ...textCandidatesByKey(source, /brand|vendor|maker|manufacturer/i)]);
  const brand = context.hints?.brand ?? normalizeMachinePrefixedBrand(inferredBrand, name, source, context.sourceUrl);
  const category = context.hints?.category ?? first([
    ...mapped.strings("category"),
    ...textCandidatesByKey(source, /categoryName|categoryPath|taxonomy|productType|product_type/i)
  ].filter(isCategorySignal));
  const directBenefitSignals = unique([
    ...normalizeFieldSignals([...semanticFacts.benefits, ...mapped.strings("benefits")], "benefit"),
    ...selectTrustedMappedRoleSignals(mapped.strings("benefits"), "benefit")
  ]);
  const inferredBenefitSignals = normalizeFieldSignals([
    ...sentenceInsightTexts(ocrSentenceInsights, "benefit"),
    ...sectionTexts(source, categoryKeywords.benefit),
    ...classifiedProductSections(source, "benefit")
  ], "benefit");
  const benefits = unique([
    ...directBenefitSignals,
    ...inferredBenefitSignals.filter((item) => !isIngredientLinkDerivedRoleCandidate(
      item,
      semanticFacts.ingredientBenefitLinks,
      directBenefitSignals,
      "outcome"
    ))
  ])
    .filter((item) => isProductScopedOutcomeEvidence(item, name))
    .slice(0, 12);
  const directEffectSignals = unique([
    ...normalizeFieldSignals([...semanticFacts.effects, ...mapped.strings("effects")], "effect"),
    ...selectTrustedMappedRoleSignals(mapped.strings("effects"), "effect")
  ]);
  const inferredEffectSignals = normalizeFieldSignals([
    ...sentenceInsightTexts(ocrSentenceInsights, "effect"),
    ...sectionTexts(source, categoryKeywords.effect),
    ...classifiedProductSections(source, "effect")
  ], "effect");
  const effects = unique([
    ...directEffectSignals,
    ...inferredEffectSignals.filter((item) => !isIngredientLinkDerivedRoleCandidate(
      item,
      semanticFacts.ingredientBenefitLinks,
      directEffectSignals,
      "outcome"
    ))
  ])
    .filter((item) => isProductScopedOutcomeEvidence(item, name))
    .slice(0, 12);
  const directIngredientSignals = unique([
    ...normalizeFieldSignals([...semanticFacts.ingredients, ...mapped.strings("ingredients")], "ingredient"),
    ...selectTrustedMappedRoleSignals(mapped.strings("ingredients"), "ingredient")
  ]);
  const inferredIngredientSignals = normalizeFieldSignals([
    ...sentenceInsightTexts(ocrSentenceInsights, "ingredient"),
    ...sectionTexts(source, categoryKeywords.ingredient),
    ...classifiedProductSections(source, "ingredient")
  ], "ingredient");
  const ingredients = unique([
    ...directIngredientSignals,
    ...inferredIngredientSignals.filter((item) => !isIngredientLinkDerivedRoleCandidate(
      item,
      semanticFacts.ingredientBenefitLinks,
      directIngredientSignals,
      "ingredient"
    ))
  ]).slice(0, 24);
  const usage = normalizeFieldSignals([...semanticFacts.usageSteps, ...mapped.strings("usage"), ...sentenceInsightTexts(ocrSentenceInsights, "usage"), ...sectionTexts(source, categoryKeywords.usage), ...classifiedProductSections(source, "usage")], "usage").slice(0, 8);
  // Preserve a broader evidence pool for semantic FAQ planning. Public FAQ is
  // still capped after buyer-intent ranking; clipping here by source order can
  // otherwise discard high-value suitability or life-stage questions that
  // appear later in the PDP source.
  const faq = uniqueFaq([...mapped.faq(), ...faqFromUnknown(source), ...looseFaq]).slice(0, 16);
  const reviews = normalizeReviews(source, mapped);
  const images = unique(mapped.strings("images").flatMap((value) => splitPotentialList(value)).map((value) => absolutizeUrl(value, context.sourceUrl))).slice(0, 80);
  const options = unique(mapped.strings("options").flatMap(splitPotentialList)).slice(0, 16);
  const priceRaw = first(mapped.strings("price"));
  const semanticMetricTexts = semanticFacts.metricClaims.flatMap(selectAtomicMetricClaimTexts);
  const representedMetricSources = new Set(semanticFacts.metricClaims
    .flatMap((claim) => [claim.sentence, claim.sourceText])
    .filter((value): value is string => Boolean(value))
    .map((value) => cleanSourceSignalText(value).toLocaleLowerCase()));
  const metrics = unique([
    ...semanticMetricTexts,
    ...sourceTexts
      .filter(isAtomicMetricEvidenceText)
      .filter((value) => !representedMetricSources.has(cleanSourceSignalText(value).toLocaleLowerCase()))
  ]).slice(0, 20);
  const breadcrumbs = normalizeBreadcrumbBrandLabels(normalizeBreadcrumbs(mapped.values("breadcrumbs"), {
    brand,
    category,
    name,
    url: context.sourceUrl
  }), inferredBrand, brand);
  const locale = context.hints?.locale ?? inferLocale([name, description, ...sourceTexts].join("\n"));
  const market = context.hints?.market ?? defaultMarketForLocale(locale);
  const ocrSentences = createOcrSentenceDiagnostics(ocrSentenceInsights, locale);

  const product = filterCurrentProductUsageInstructions({
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
    sourceTexts,
    semanticFacts
  });

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

function isIngredientLinkDerivedRoleCandidate(
  value: string,
  links: PdpSemanticIngredientBenefitLink[],
  directRoleSignals: string[],
  role: "ingredient" | "outcome"
): boolean {
  const candidate = normalizeEvidenceEntityText(value);
  if (!candidate || directRoleSignals.some((signal) => normalizeEvidenceEntityText(signal) === candidate)) {
    return false;
  }
  const linkedValues = links.flatMap((link) => role === "outcome"
    ? [link.benefit, link.effect, link.sentence, link.sourceText]
    : [link.benefit, link.effect, link.sentence, link.sourceText]);
  return linkedValues.some((linkedValue) => Boolean(linkedValue)
    && normalizeEvidenceEntityText(linkedValue ?? "") === candidate);
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

/**
 * Some upstream commerce feeds expose a machine namespace together with the
 * brand as a kebab-cased token (for example, `region-brand`). Strip that
 * namespace only when the URL and visible PDP text independently identify the
 * suffix as the brand. This keeps legitimate hyphenated brands unchanged.
 */
function normalizeMachinePrefixedBrand(
  candidate: string | undefined,
  productName: string,
  source: unknown,
  sourceUrl: string | undefined
): string | undefined {
  const brand = candidate ? cleanText(candidate) : undefined;
  if (!brand || !sourceUrl || brand !== brand.toLowerCase() || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(brand)) {
    return brand;
  }

  let hostnameLabels: string[];
  try {
    hostnameLabels = new URL(sourceUrl).hostname.toLowerCase().split(".").filter(Boolean);
  } catch {
    return brand;
  }

  const domainBrandLabel = registrableBrandLabel(hostnameLabels);
  const parts = brand.split("-");
  const suffix = parts.at(-1);
  const prefixParts = parts.slice(0, -1);
  if (!suffix || suffix !== domainBrandLabel || prefixParts.some((part) => hostnameLabels.includes(part))) {
    return brand;
  }

  const visibleTexts = unique([productName, ...allStrings(source)]
    .map(cleanText)
    .filter((text) => text.length > 0 && text.toLowerCase() !== brand && !isUrlLikeText(text)));
  const fullCandidatePattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${parts.map(escapeRegExp).join("[-\\s]+")}(?=$|[^\\p{L}\\p{N}])`,
    "iu"
  );
  if (visibleTexts.some((text) => fullCandidatePattern.test(text))) {
    return brand;
  }

  const suffixPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escapeRegExp(suffix)})(?=$|[^\\p{L}\\p{N}])`, "iu");
  for (const text of visibleTexts) {
    const surface = suffixPattern.exec(text)?.[1];
    if (surface) {
      return surface === surface.toLowerCase()
        ? `${surface.charAt(0).toUpperCase()}${surface.slice(1)}`
        : surface;
    }
  }
  return brand;
}

function registrableBrandLabel(hostnameLabels: string[]): string | undefined {
  if (hostnameLabels.length < 2) {
    return undefined;
  }
  const countryTld = hostnameLabels.at(-1)?.length === 2;
  const secondLevelSuffix = hostnameLabels.at(-2);
  const usesCountrySecondLevelSuffix = countryTld && /^(?:ac|co|com|go|gov|net|ne|org|or)$/i.test(secondLevelSuffix ?? "");
  return hostnameLabels.at(usesCountrySecondLevelSuffix ? -3 : -2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    fallback.url ? breadcrumbHomeItem(fallback.url) : undefined,
    fallback.category ? { name: fallback.category } : undefined,
    !fallback.category && fallback.brand ? { name: fallback.brand } : undefined,
    { name: fallback.name, url: fallback.url }
  ].filter((item): item is PdpGeoBreadcrumbItem => Boolean(item));

  const hierarchy = items.length >= 2
    ? items
    : uniqueBreadcrumbs([
      fallback.url ? breadcrumbHomeItem(fallback.url) : undefined,
      fallback.category ? { name: fallback.category } : undefined,
      ...items,
      ...fallbackItems
    ].filter((item): item is PdpGeoBreadcrumbItem => Boolean(item)));

  return uniqueBreadcrumbs(hierarchy).slice(0, 6);
}

function breadcrumbHomeItem(url: string): PdpGeoBreadcrumbItem | undefined {
  try {
    const origin = new URL(url).origin;
    return { name: "Home", url: origin };
  } catch {
    return undefined;
  }
}

function normalizeBreadcrumbBrandLabels(
  items: PdpGeoBreadcrumbItem[],
  sourceBrand: string | undefined,
  normalizedBrand: string | undefined
): PdpGeoBreadcrumbItem[] {
  const sourceKey = sourceBrand ? cleanText(sourceBrand).toLowerCase() : "";
  if (!sourceKey || !normalizedBrand || sourceKey === normalizedBrand.toLowerCase()) {
    return items;
  }
  return items.map((item) => cleanText(item.name).toLowerCase() === sourceKey
    ? { ...item, name: normalizedBrand }
    : item);
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

export type PdpEvidenceSemanticRole =
  | ProductSignalField
  | "audience"
  | "safety"
  | "review"
  | "metric"
  | "faq"
  | "commerce"
  | "source";

export interface PdpEvidenceRoleInference {
  primaryRole: PdpEvidenceSemanticRole;
  roles: PdpEvidenceSemanticRole[];
  canLinkIngredientToOutcome: boolean;
}

/**
 * Classifies a source-backed evidence unit before it is routed into ProductSignal.
 * The classifier is intentionally product-agnostic: it reasons from the linguistic
 * job of the evidence (direction, substance, outcome, measurement, safety, etc.)
 * rather than from a brand or a known product vocabulary.
 */
export function inferPdpEvidenceRoles(value: string): PdpEvidenceRoleInference {
  const text = cleanSourceSignalText(value);
  if (!text) {
    return { primaryRole: "source", roles: ["source"], canLinkIngredientToOutcome: false };
  }

  if (isQuestionLikeSourceText(text) || /[?？]/u.test(text)) {
    return { primaryRole: "faq", roles: ["faq"], canLinkIngredientToOutcome: false };
  }

  const roles: PdpEvidenceSemanticRole[] = [];
  const commerceOnly = isCommerceQuantityOrOfferText(text);
  const safety = isSafetyOrSuitabilityCaution(text);
  const review = isCustomerExperienceEvidence(text);
  const usage = !safety && !review && !commerceOnly && isUsageInstruction(text);
  const metric = !commerceOnly && isAtomicMetricEvidenceText(text);
  const ingredient = !commerceOnly && !review && isIngredientSignal(text) && isRoleCoherentIngredientEvidence(text);
  // A standalone ingredient/formula name can legitimately contain outcome
  // vocabulary (for example, "Hydration Boost Complex"). Those words are part
  // of the proper name and do not, by themselves, assert a product outcome.
  const standaloneNamedIngredient = ingredient && isNamedBiochemicalOrFormula(text);
  const benefit = !standaloneNamedIngredient && !safety && !review && !usage && !commerceOnly && !metric && isBenefitEvidenceRole(text);
  const effect = !standaloneNamedIngredient && !safety && !review && !usage && !commerceOnly && isEffectSignal(text);
  const audience = isAudienceEvidence(text);

  if (commerceOnly) roles.push("commerce");
  if (safety) roles.push("safety");
  if (review) roles.push("review");
  if (usage) roles.push("usage");
  if (metric) roles.push("metric");
  if (ingredient) roles.push("ingredient");
  if (benefit) roles.push("benefit");
  if (effect) roles.push("effect");
  if (audience) roles.push("audience");

  const canLinkIngredientToOutcome = ingredient && (benefit || effect) && !metric && !review && !safety;
  const primaryRole = firstSemanticRole(roles, canLinkIngredientToOutcome);
  return {
    primaryRole,
    roles: roles.length > 0 ? uniqueSemanticRoles(roles) : ["source"],
    canLinkIngredientToOutcome
  };
}

function firstSemanticRole(roles: PdpEvidenceSemanticRole[], ingredientOutcomeLink: boolean): PdpEvidenceSemanticRole {
  const precedence: PdpEvidenceSemanticRole[] = [
    "faq",
    "review",
    "safety",
    "usage",
    "commerce",
    "metric",
    ...(ingredientOutcomeLink ? ["ingredient" as const] : []),
    "audience",
    "benefit",
    "effect",
    "ingredient"
  ];
  return precedence.find((role) => roles.includes(role)) ?? "source";
}

function uniqueSemanticRoles(roles: PdpEvidenceSemanticRole[]): PdpEvidenceSemanticRole[] {
  return Array.from(new Set(roles));
}

function normalizeFieldSignals(values: string[], field: ProductSignalField): string[] {
  return unique(values
    .flatMap((value) => splitMixedEvidenceUnits(value, field))
    .map(cleanSourceSignalText)
    .map((value) => field === "usage" ? normalizeSourceUsageInstruction(value) : value)
    .filter((value) => isAllowedFieldSignal(value, field)));
}

/**
 * Explicitly mapped arrays already carry a strong source role. Preserve novel
 * names/terms from those fields unless linguistic evidence proves a conflict;
 * the lexical classifier is a fallback, not an allowlist.
 */
function selectTrustedMappedRoleSignals(values: string[], field: Exclude<ProductSignalField, "usage">): string[] {
  return unique(values
    .flatMap((value) => splitMixedEvidenceUnits(value, field))
    .map(cleanSourceSignalText)
    .filter((value) => isTrustedMappedRoleSignal(value, field)));
}

function isTrustedMappedRoleSignal(value: string, field: Exclude<ProductSignalField, "usage">): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || !isUsefulSourceText(text) || isQuestionLikeSourceText(text) || isCommerceQuantityOrOfferText(text)) {
    return false;
  }
  if (field === "ingredient" && /^(?:ingredients?|actives?|formula|성분|원료|전성분|成分|原料)$/iu.test(text)) {
    return false;
  }
  if ((field === "benefit" || field === "effect") && /^(?:benefits?|effects?|results?|claims?|효능|효과|장점|결과|効果|ベネフィット)$/iu.test(text)) {
    return false;
  }
  const inference = inferPdpEvidenceRoles(text);
  if (inference.roles.includes(field)) {
    return true;
  }
  const conflicts = new Set<PdpEvidenceSemanticRole>(inference.roles.filter((role) => role !== "source"));
  if (field === "ingredient") {
    if (conflicts.size > 0 || (!isFullIngredientList(text) && (text.length > 120 || /[.!?。！？]/u.test(text)))) {
      return false;
    }
    return !/^(?:absorption|absorbency|retention|persistence|texture|finish|efficacy|effect|duration|hydration|moisture|firmness|흡수력|흡수성|잔존|유지력|지속력|제형|질감|사용감|효능|효과|기간|보습력|수분감|탄력|피부\s*타입)$/iu.test(text)
      && !/^\d+(?:[.,]\d+)?\s*(?:%|％|배|hours?|days?|weeks?|시간|일|주)?$/iu.test(text);
  }
  if (["usage", "safety", "review", "metric", "faq", "commerce", "ingredient"].some((role) => conflicts.has(role as PdpEvidenceSemanticRole))) {
    return false;
  }
  return text.length <= 100 && !/[.!?。！？]/u.test(text) && /[\p{L}]/u.test(text);
}

function splitMixedEvidenceUnits(value: string, field: ProductSignalField): string[] {
  const text = cleanSourceSignalText(value);
  if (!text || field === "usage") {
    return text ? [text] : [];
  }
  if (field === "ingredient") {
    const embeddedIngredientList = text.search(/(?:^|\s)(?:ingredients?|전성분|全成分)\s*[:：]/i);
    if (embeddedIngredientList > 0) {
      return [
        ...splitMixedEvidenceUnits(text.slice(0, embeddedIngredientList), field),
        text.slice(embeddedIngredientList).trim()
      ].filter(Boolean);
    }
    if (isFullIngredientList(text)) {
      return [text];
    }
  }
  const units = text
    .split(/(?:\r?\n|\s*[•●▪■]\s*|(?<=[.!?。！？])\s+(?=[\p{L}\p{N}]))/u)
    .map(cleanSourceSignalText)
    .filter(Boolean);
  return units.length > 0 ? units : [text];
}

function isAllowedFieldSignal(value: string, field: ProductSignalField): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || !isUsefulSourceText(text) || isQuestionLikeSourceText(text)) {
    return false;
  }
  return inferPdpEvidenceRoles(text).roles.includes(field);
}

function isUsefulSourceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const maxLength = isFullIngredientList(text) ? fullIngredientListTextLimit : 700;
  if (text.length < 2 || text.length > maxLength || isUrlLikeText(text) || isOcrFootnote(text) || isLikelyVisualImageDescription(text)) {
    return false;
  }
  if (isCrossSellRoutineText(text)) {
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
  if (/^(?:how\s+to\s+use|directions?|usage\s+instructions?)\b\s*[.:：]?/iu.test(text)) {
    return false;
  }
  return /(?:무엇|뭐|어떤|어떻게|왜|언제|어디|누가|가능|괜찮|되나|되나요|인가요|있나요|해주는\s*것인가요|할까요|좋나요|궁금(?:합니다|해요)?|알고\s*싶(?:습니다|어요)?)\s*[.!。]?\s*$/.test(text)
    || /^(?:what|how|why|when|where|who|which|can|does|do|is|are)\b/i.test(text)
    || /\b(?:i\s+wonder|would\s+like\s+to\s+know|want\s+to\s+know)\b/i.test(text);
}

function isConciseBenefitSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (/^(benefits?|효능|효과|장점|ベネフィット)$/i.test(text)) {
    return false;
  }
  if (isMetricEvidenceText(text)) {
    return false;
  }
  if (text.length > 90 || /[.。]/.test(text) || isBrokenSourceFragment(text)) {
    return false;
  }
  return /benefit|hydration|moisture|firm|elastic|barrier|bright|soothing|comfort|wrinkle|fine lines?|plump|lifting|수분|보습|장벽|탄력|진정|피부결|쿨링|붉은기|저자극|속수분|유수분|保湿|うるおい|ハリ|バリア/i.test(text);
}

function isBenefitEvidenceRole(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (isConciseBenefitSignal(text)) {
    return true;
  }
  if (!text || text.length > 320 || isFullIngredientList(text) || isBrokenSourceFragment(text)
    || /^(benefits?|효능|효과|장점|ベネフィット)$/i.test(text)) {
    return false;
  }
  return hasOutcomeLanguage(text);
}

function isEffectSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length > 320 || /^(?:effect|effects|result|results|benefit|benefits|효과|효능|개선|결과)$/i.test(text)) {
    return false;
  }
  return /effect|clinical|result|improve|supports?|hydration|moisture|barrier|soothing|firm|elastic|texture|cooling|sebum|효과|효능|개선|수분|보습|장벽|진정|탄력|피부결|쿨링|피지|유분|속수분|유수분|保湿|効果|キメ/i.test(text);
}

function isRoleCoherentIngredientEvidence(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || isBrokenSourceFragment(text)) {
    return false;
  }
  if (isFullIngredientList(text) || (!/[.!?。！？]/.test(text) && text.length <= 80)) {
    return true;
  }
  if (/^(?:helps?|supports?|improves?|boosts?|strengthens?|leaves?|delivers?|addresses?|this\s+(?:unique\s+)?(?:compound|product)|이러한?\s*(?:성분|복합체|제품))/i.test(text)) {
    return false;
  }
  if (/^this\s+(?:advanced\s+|unique\s+)?formula\b/i.test(text)
    && !/^this\s+(?:advanced\s+|unique\s+)?formula\s+(?:contains?|includes?|combines?|uses?)\b/i.test(text)) {
    return false;
  }
  const firstClause = (text.split(/[.!?。！？]/u)[0] ?? text).slice(0, 100);
  return /ingredient|active|formula|technology|complex|blend|extract|ferment|peptide|ceramide|hyaluronic|retinol|niacinamide|ginseng|성분|원료|기술|포뮬러|복합체|추출|발효|펩타이드|세라마이드|히알루론산|레티놀|나이아신아마이드|인삼|캡슐/i.test(firstClause)
    || /^(?:this|the)\s+(?:formula|blend|complex|technology)\s+(?:contains?|includes?|combines?|uses?)\b/i.test(text);
}

function isIngredientSignal(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (isBrokenSourceFragment(text)) {
    return false;
  }
  if (isFullIngredientList(text)) {
    return text.length <= fullIngredientListTextLimit;
  }
  if (isMetricEvidenceText(text)) {
    return false;
  }
  if (text.length > 360) {
    return false;
  }
  if (/^(성분|원료|ingredient|ingredients)$/i.test(text)) {
    return false;
  }
  return /ingredients?|active|actives?|formula|technology|tech|complex|blend|ferment|extract|herb|전성분|성분표|히알루론산|하이알루론산|세라마이드|징크|zinc|ha\b|캡슐|복합체|ceramide|hyaluronic|retinol|niacinamide|peptide|ginseng|panthenol|aqua|glycerin/i.test(text)
    || isNamedBiochemicalOrFormula(text);
}

function isNamedBiochemicalOrFormula(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || text.length > 80 || /[.!?。！？]/.test(text) || /^(?:skin|피부)\b/i.test(text)) {
    return false;
  }
  return /^[\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,4}\s+(?:acid|glucan|glycan|vitamin|enzyme|protein|lipid|sterol|alcohol|oxide|filtrate|ferment|complex|blend|extract|oil|butter|peptide|ceramide|retinoid|technology|formula)(?:[™®])?$/iu.test(text)
    || /(?:추출물|발효물|여과물|복합체|펩타이드|세라마이드|비타민|아미노산|지질|오일|버터|기술|포뮬러)(?:[™®])?$/u.test(text);
}

function isCommerceQuantityOrOfferText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text) {
    return false;
  }
  const withoutLabel = text.replace(/^(?:size|volume|capacity|용량|중량|사이즈)\s*[:：]?\s*/i, "").trim();
  if (/^\d+(?:\.\d+)?\s*(?:ml|mL|l|g|kg|oz|fl\.?\s*oz|개입|매|정)\b\.?$/i.test(withoutLabel)) {
    return true;
  }
  return /^(?:[$€£¥₩]\s*\d[\d,.]*|\d[\d,.]*\s*(?:원|usd|krw|jpy|eur|gbp))$/i.test(withoutLabel)
    || /(?:add\s+to\s+(?:bag|cart)|buy\s+now|sale\s+price|regular\s+price|장바구니|구매하기|판매가|할인가|쿠폰|배송|교환|반품)/i.test(text);
}

function isSafetyOrSuitabilityCaution(value: string): boolean {
  const text = cleanSourceSignalText(value);
  return /(?:patch\s*test|patch\s*testing|test\s+on\s+a\s+small\s+area|discontinue\s+use|avoid\s+contact|for\s+external\s+use|consult\s+(?:a|your)\s+(?:doctor|physician)|caution|warning|hypoallergenic|dermatologist[-\s]?tested|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should)/i.test(text)
    || /(?:국소\s*부위|팔\s*안쪽|귀\s*뒤|패치\s*테스트|사용\s*전\s*테스트|이상\s*증상|사용을\s*중지|전문의와\s*상담|주의사항|외용으로만|극민감\s*(?:피부\s*)?테스트|민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트|피부\s*자극\s*테스트|피부과\s*테스트|여드름성\s*피부\s*사용\s*적합\s*테스트|알러지\s*테스트|인체\s*안자극\s*테스트|소아과\s*피부\s*테스트|하이포알러지|논코메도제닉)/u.test(text);
}

function isCustomerExperienceEvidence(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (/\b(?:review|reviews|reviewer|customer\s+said|customer\s+reported|verified\s+buyer|stars?)\b/i.test(text)
    || /(?:고객\s*리뷰|구매\s*후기|리뷰에서|후기에서|평점|재구매|구매했|사용해\s*봤|써\s*봤)/u.test(text)) {
    return true;
  }
  return /\bI\s+(?:bought|used|tried|love|liked|recommend)\b/i.test(text)
    || /(?:직접|저는|제가|구매(?:해|했)|사용해\s*보)[^.!?。！？]{0,160}(?:촉촉|편안|만족|좋(?:아|았|습니))/u.test(text)
    || /(?:좋아요|좋았습니다|마음에\s*들|만족(?:해|했|합니다)|느낌이네요|같아요)\s*[.!。]?$/u.test(text);
}

function isAudienceEvidence(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (/^(?:sensitive|dry|oily|combination|normal|mature|all)\s+skin(?:\s+types?)?$/i.test(text)
    || /^(?:민감|건조|건성|지성|복합성?|중성|성숙)\s*피부$/u.test(text)) {
    return true;
  }
  return /^(?:(?:sensitive|dry|oily|combination|normal|mature)\s*(?:or|and|,)\s*)+(?:sensitive|dry|oily|combination|normal|mature)\s+skin(?:\s+types?)?$/i.test(text)
    || /(?:suitable\s+for|recommended\s+for|ideal\s+for|designed\s+for|for\s+(?:people|customers|skin)|all\s+skin\s+types|normal\s+and\s+combination\s+skin)/i.test(text)
    || /(?:(?:고객|피부)에?게\s*(?:적합|추천)|(?:위한|고려한)\s*(?:제품|포뮬러|케어)|(?:민감|건조|건성|지성|복합성?|중성)\s*피부)/u.test(text);
}

function isAtomicMetricEvidenceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || text.length < 12 || text.length > 700 || isQuestionLikeSourceText(text) || isCommerceQuantityOrOfferText(text)) {
    return false;
  }
  if (isCompressedMultiClaimMetricBlock(text)) {
    return false;
  }
  if (/\b1\s+(?:weeks|days|hours)\b/i.test(text) || /["']\s*$/.test(text)) {
    return false;
  }
  if (/^(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\.?$/i.test(text)
    || /^\d+(?:\.\d+)?\s*(?:%|배|weeks?|days?|hours?|주|일|시간)\.?$/i.test(text)) {
    return false;
  }
  const quantifiedResult = /\d+(?:\.\d+)?\s*(?:%|배|times?|points?|점|층|layers?|시간|hours?|°\s*[CF]|degrees?\s+(?:Celsius|Fahrenheit))(?:\*|\s|$|[.,;:])/i.test(text)
    || /(?:increased?|decreased?|improved?|reduced?|higher|lower|boosted?|rose|fell|증가|감소|개선|완화|높|낮)[^.!?。！？]{0,32}\d+(?:\.\d+)?\s*(?:%|배|점)?/i.test(text);
  const outcome = /(?:firm|elastic|wrinkle|fine\s*line|hydration|moisture|barrier|texture|radiance|plump|smooth|density|retention|soothing|cooling|temperature|탄력|주름|수분|보습|장벽|피부결|광채|밀도|잔존|진정|쿨링|시원|온도|개선|효과)/i.test(text);
  const evidenceFrame = /(?:study|clinical|instrumental|assessment|evaluation|test(?:ed)?|participants?|subjects?|women|men|users?|agreed|reported|result|versus|\bvs\.?\b|시험|실험|평가|측정|대상|참여자|사용자|결과|대비)/i.test(text)
    || /(?:after|over|in)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\b/i.test(text)
    || /\d+(?:\.\d+)?\s*(?:주|일|시간)\s*(?:후|동안)/u.test(text)
    || /(?:사용\s*직후|단\s*\d+(?:\.\d+)?\s*분\s*만에|한\s*번만?\s*발라도|1\s*회\s*사용)/u.test(text);
  const durationOutcome = /\d+(?:\.\d+)?\s*시간[^.!?。！？]{0,40}(?:보습|수분)[^.!?。！？]{0,24}지속|(?:보습|수분)[^.!?。！？]{0,40}\d+(?:\.\d+)?\s*시간[^.!?。！？]{0,24}지속/u.test(text);
  return (quantifiedResult || durationOutcome) && outcome && evidenceFrame;
}

/**
 * Rejects OCR glue blocks that contain several independent measurements and a
 * shared footnote/study context. They remain available in `sourceTexts` for
 * evidence atomisation, but must not masquerade as one atomic metric claim.
 * The gate is based on linguistic structure, never on a product name or a
 * known product-specific number.
 */
function isCompressedMultiClaimMetricBlock(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (/(?:사용|도포|적용|세정)\s*전\s*(?:사용|도포|적용|세정)\s*후/u.test(text)) {
    return true;
  }

  const timingAnchors = text.match(/(?:사용|도포|적용|세정)\s*(?:직후|즉시|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*(?:후|만에)?)|(?:단\s*)?\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월)\s*만에|(?:한\s*번(?:만)?|1\s*회)\s*(?:사용|도포|발라)/gu) ?? [];
  const outcomeAnchors = text.match(/\d+(?:\.\d+)?\s*(?:%|％|배)\s*(?:증가|감소|개선|회복|향상|완화|상승|잔존)/gu) ?? [];
  const hasSharedStudyContext = /(?:※|(?:㈜|\(주\)|주식회사)|인체\s*적용\s*시험|임상\s*시험|소비자\s*평가|\d+\s*명\s*대상)/u.test(text);
  const hasOcrDurationToken = /\b\d+(?:\.\d+)?\s*h\b/iu.test(text);
  return outcomeAnchors.length >= 2
    && timingAnchors.length >= 2
    && (hasSharedStudyContext || hasOcrDurationToken || text.length > 260);
}

function isBrokenSourceFragment(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  return openParens !== closeParens
    || /(?:…|\.\.\.)\s*$/.test(text)
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
const fullIngredientListTextLimit = 2400;

interface OcrSentenceInsightInput {
  text: string;
  imageUrl?: string;
  category: OcrSentenceCategory;
  keywords: string[];
  semanticFacts?: Partial<PdpSemanticFacts>;
}

interface OcrTextCandidateInput {
  text: string;
  imageUrl?: string;
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
    const imageUrl = ocrImageUrlFromRecord(item);
    const keywords = flattenTextValues(item.keywords).slice(0, 10);

    if (!text) {
      return [];
    }

    return inferOcrSentenceCategories(text, keywords, category).map((inferredCategory) => ({
      text,
      imageUrl,
      category: inferredCategory,
      keywords,
      semanticFacts: isRecord(item.semanticFacts) ? normalizeSemanticFactsObject(item.semanticFacts) : undefined
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
    const key = `${item.category}:${item.text.toLowerCase()}:${item.imageUrl ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return item.text.length > 0;
  });
}

function normalizeSemanticFacts(source: unknown, insights: OcrSentenceInsightInput[], productName: string): PdpSemanticFacts {
  return scopeSemanticFactsToProduct(sanitizePdpSemanticFacts(mergeSemanticFacts(
    ...[
      getByPath(source, "semanticFacts"),
      getByPath(source, "geoProduct.semanticFacts"),
      getByPath(source, "sourceExtraction.ocr.semanticFacts"),
      getByPath(source, "ocr.semanticFacts"),
      getByPath(source, "aiAnalysis.semanticFacts"),
      ...insights.map((insight) => ({
        ingredients: insight.category === "ingredient" ? semanticInsightValues(insight) : [],
        benefits: insight.category === "benefit" ? [insight.text] : [],
        effects: insight.category === "effect" ? [insight.text] : [],
        skinTypes: [],
        usageSteps: insight.category === "usage" ? [insight.text] : [],
        safetyTests: inferPdpEvidenceRoles(insight.text).roles.includes("safety") ? [insight.text] : [],
        metricClaims: insight.category === "metric" ? [{ sentence: insight.text, sourceText: insight.text }] : [],
        evidenceSentences: [insight.text],
        citations: [],
        ingredientBenefitLinks: insight.category === "ingredient" && hasOutcomeLanguage(insight.text)
          ? [{ sentence: insight.text, sourceText: insight.text }]
          : [],
        ...insight.semanticFacts
      }))
    ].map((item) => isRecord(item) ? normalizeSemanticFactsObject(item) : undefined)
  )), productName);
}

function semanticInsightValues(insight: OcrSentenceInsightInput): string[] {
  return insight.keywords.length > 0 ? insight.keywords : [insight.text];
}

function normalizeSemanticFactsObject(value: Record<string, unknown>): Partial<PdpSemanticFacts> {
  return {
    ingredients: textArray(value.ingredients),
    benefits: textArray(value.benefits),
    effects: textArray(value.effects),
    skinTypes: textArray(value.skinTypes),
    usageSteps: textArray(value.usageSteps),
    safetyTests: textArray(value.safetyTests),
    evidenceSentences: textArray(value.evidenceSentences),
    metricClaims: readSemanticMetricClaims(value.metricClaims),
    ingredientBenefitLinks: readSemanticIngredientBenefitLinks(value.ingredientBenefitLinks),
    citations: readSemanticCitations(value.citations)
  };
}

function mergeSemanticFacts(...values: Array<Partial<PdpSemanticFacts> | undefined>): PdpSemanticFacts {
  return {
    ingredients: unique(values.flatMap((item) => item?.ingredients ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 24),
    benefits: unique(values.flatMap((item) => item?.benefits ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 24),
    effects: unique(values.flatMap((item) => item?.effects ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 24),
    skinTypes: unique(values.flatMap((item) => item?.skinTypes ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 16),
    usageSteps: unique(values.flatMap((item) => item?.usageSteps ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 16),
    safetyTests: unique(values.flatMap((item) => item?.safetyTests ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 24),
    metricClaims: uniqueSemanticMetricClaims(values.flatMap((item) => item?.metricClaims ?? [])).slice(0, 24),
    evidenceSentences: unique(values.flatMap((item) => item?.evidenceSentences ?? []).map(cleanText).filter(isUsefulSourceText)).slice(0, 32),
    ingredientBenefitLinks: uniqueSemanticIngredientBenefitLinks(values.flatMap((item) => item?.ingredientBenefitLinks ?? [])).slice(0, 24),
    citations: uniqueSemanticCitations(values.flatMap((item) => item?.citations ?? [])).slice(0, 16)
  };
}

/** Removes cross-role leakage from semantic facts before any public field consumes it. */
export function sanitizePdpSemanticFacts(value: Partial<PdpSemanticFacts>): PdpSemanticFacts {
  const ingredients = normalizeFieldSignals(value.ingredients ?? [], "ingredient").slice(0, 24);
  const benefits = normalizeFieldSignals(value.benefits ?? [], "benefit").slice(0, 24);
  const effects = normalizeFieldSignals(value.effects ?? [], "effect").slice(0, 24);
  const usageSteps = normalizeFieldSignals(value.usageSteps ?? [], "usage").slice(0, 16);
  const safetyTests = unique((value.safetyTests ?? [])
    .map(cleanSourceSignalText)
    .filter((item) => inferPdpEvidenceRoles(item).roles.includes("safety")))
    .slice(0, 24);
  const skinTypes = unique((value.skinTypes ?? [])
    .map(cleanSourceSignalText)
    .filter((item) => inferPdpEvidenceRoles(item).roles.includes("audience"))
    .filter((item) => !isSafetyOrSuitabilityCaution(item)))
    .slice(0, 16);
  const metricClaims = uniqueSemanticMetricClaims((value.metricClaims ?? [])
    .filter(isCoherentSemanticMetricClaim))
    .slice(0, 24);
  const ingredientBenefitLinks = uniqueSemanticIngredientBenefitLinks((value.ingredientBenefitLinks ?? [])
    .filter(isCoherentIngredientBenefitLink))
    .slice(0, 24);
  const citations = uniqueSemanticCitations((value.citations ?? [])
    .filter(isCoherentSemanticCitation))
    .slice(0, 16);

  return {
    ingredients,
    benefits,
    effects,
    skinTypes,
    usageSteps,
    safetyTests,
    metricClaims,
    evidenceSentences: unique((value.evidenceSentences ?? [])
      .map(cleanSourceSignalText)
      .filter(isUsefulSourceText))
      .slice(0, 32),
    ingredientBenefitLinks,
    citations
  };
}

function scopeSemanticFactsToProduct(value: PdpSemanticFacts, productName: string): PdpSemanticFacts {
  return {
    ...value,
    benefits: value.benefits.filter((item) => isProductScopedOutcomeEvidence(item, productName)),
    effects: value.effects.filter((item) => isProductScopedOutcomeEvidence(item, productName)),
    usageSteps: value.usageSteps.filter((item) => !/[?？]/u.test(item))
  };
}

function isProductScopedOutcomeEvidence(value: string, productName: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!text || isQuestionLikeSourceText(text) || /[?？]/u.test(text)) {
    return false;
  }
  if (isDefinitionalOrEducationalStatement(text)) {
    return false;
  }
  if (text.length <= 90) {
    return true;
  }
  const normalizedText = normalizeEvidenceEntityText(text);
  const productTokens = normalizeEvidenceEntityText(productName)
    .split(" ")
    .filter((token) => token.length >= 3 && !/^(?:cream|serum|lotion|toner|product|크림|세럼|로션|토너)$/.test(token));
  const mentionsProduct = productTokens.some((token) => normalizedText.includes(token));
  const hasProductOrFormulaSubject = /^(?:this|the|our)\s+(?:product|formula|serum|cream|lotion|toner|blend|complex)|(?:제품|상품|포뮬러|세럼|크림|로션|토너|라인)(?:은|는|이|가|에는)/i.test(text);
  return mentionsProduct || hasProductOrFormulaSubject || inferPdpEvidenceRoles(text).canLinkIngredientToOutcome;
}

function isDefinitionalOrEducationalStatement(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const definitional = /\b(?:means|refers\s+to|is\s+defined\s+as|consists\s+of|is\s+made\s+of)\b/i.test(text)
    || /(?:은|는)\s*말\s*그대로|(?:이란|란)\s|(?:로|으로)\s*이루어져\s*(?:있|있고)/u.test(text);
  const productAction = /(?:helps?|supports?|improves?|strengthens?|reinforces?|hydrates?|moisturizes?|돕|개선|강화|보습|진정|완화|공급|채워)/i.test(text);
  return definitional && !productAction;
}

function normalizeEvidenceEntityText(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function isCoherentSemanticMetricClaim(claim: PdpSemanticMetricClaim): boolean {
  return selectAtomicMetricClaimTexts(claim).length > 0;
}

function selectAtomicMetricClaimTexts(claim: PdpSemanticMetricClaim): string[] {
  if (isStructuredAtomicMetricClaim(claim)) {
    const structured = formatStructuredAtomicMetricClaim(claim);
    return structured ? [structured] : [];
  }
  const direct = unique([claim.sentence, claim.sourceText]
    .filter((item): item is string => Boolean(item))
    .map(cleanSourceSignalText)
    .filter(isAtomicMetricEvidenceText));
  if (direct.length > 0) {
    return direct;
  }
  return [];
}

function isStructuredAtomicMetricClaim(claim: PdpSemanticMetricClaim): boolean {
  const value = cleanSourceSignalText([claim.value, claim.unit].filter(Boolean).join(""));
  const outcome = cleanSourceSignalText(claim.metric ?? claim.label ?? claim.subject ?? "");
  const context = cleanSourceSignalText([
    claim.sample,
    claim.period,
    claim.timing,
    claim.baseline,
    claim.comparator,
    claim.method,
    claim.institution,
    claim.caveat
  ].filter(Boolean).join(" "));
  const publicText = cleanSourceSignalText(claim.sourceText ?? claim.sentence ?? "");
  if (!value || !outcome || !context || isCommerceQuantityOrOfferText(value)) {
    return false;
  }
  if (/\b1\s+(?:weeks|days|hours)\b/i.test(`${context} ${publicText}`) || /["']\s*$/.test(publicText)) {
    return false;
  }
  const quantified = /\d+(?:\.\d+)?\s*(?:%|배|times?|points?|점|층|layers?|시간|hours?|°\s*[CF]|degrees?\s+(?:Celsius|Fahrenheit))(?:\s|$|[.,;:])/i.test(value);
  const contextualized = /\d|study|test|assessment|evaluation|participant|subject|user|week|day|hour|baseline|compar|시험|실험|평가|측정|대상|참여|대비|비교|주|일|시간/i.test(context);
  return quantified && contextualized && /[\p{L}]/u.test(outcome);
}

function formatStructuredAtomicMetricClaim(claim: PdpSemanticMetricClaim): string | undefined {
  const outcome = cleanSourceSignalText(claim.label ?? claim.subject ?? claim.metric ?? "");
  const value = cleanSourceSignalText([claim.value, claim.unit].filter(Boolean).join(""));
  if (!outcome || !value) {
    return undefined;
  }
  const result = cleanSourceSignalText([outcome, value, claim.direction].filter(Boolean).join(" "));
  const context = unique([
    claim.timing,
    claim.baseline,
    claim.comparator,
    claim.sample,
    claim.period,
    claim.method,
    claim.institution,
    claim.caveat
  ].map((item) => cleanSourceSignalText(item ?? "")).filter(Boolean));
  return cleanSourceSignalText(context.length > 0 ? `${result} (${context.join("; ")})` : result);
}

function isCoherentIngredientBenefitLink(link: PdpSemanticIngredientBenefitLink): boolean {
  const ingredient = cleanSourceSignalText(link.ingredient ?? "");
  const outcome = cleanSourceSignalText(link.benefit ?? link.effect ?? "");
  if (ingredient && outcome) {
    return inferPdpEvidenceRoles(ingredient).roles.includes("ingredient")
      && inferPdpEvidenceRoles(outcome).roles.some((role) => role === "benefit" || role === "effect");
  }
  const sentence = cleanSourceSignalText(link.sentence ?? link.sourceText ?? "");
  return inferPdpEvidenceRoles(sentence).canLinkIngredientToOutcome;
}

function textArray(value: unknown): string[] {
  return flattenTextValues(value).map(cleanText).filter(isUsefulSourceText);
}

function readSemanticMetricClaims(value: unknown): PdpSemanticMetricClaim[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item): PdpSemanticMetricClaim[] => {
    if (!isRecord(item)) {
      return [];
    }
    return [{
      label: stringValue(item.label),
      subject: stringValue(item.subject),
      value: stringValue(item.value),
      unit: stringValue(item.unit),
      metric: stringValue(item.metric),
      direction: stringValue(item.direction),
      timing: stringValue(item.timing),
      baseline: stringValue(item.baseline),
      comparator: stringValue(item.comparator),
      period: stringValue(item.period),
      sample: stringValue(item.sample),
      method: stringValue(item.method),
      institution: stringValue(item.institution),
      evidenceGroup: stringValue(item.evidenceGroup),
      caveat: stringValue(item.caveat),
      sentence: stringValue(item.sentence),
      sourceText: stringValue(item.sourceText)
    }];
  });
}

function readSemanticIngredientBenefitLinks(value: unknown): PdpSemanticIngredientBenefitLink[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item): PdpSemanticIngredientBenefitLink[] => {
    if (!isRecord(item)) {
      return [];
    }
    return [{
      ingredient: stringValue(item.ingredient),
      benefit: stringValue(item.benefit),
      effect: stringValue(item.effect),
      sentence: stringValue(item.sentence),
      sourceText: stringValue(item.sourceText)
    }];
  });
}

function readSemanticCitations(value: unknown): PdpSemanticCitation[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item): PdpSemanticCitation[] => {
    if (!isRecord(item)) return [];
    const type = stringValue(item.type);
    return [{
      type: type === "article" || type === "research" ? type : undefined,
      title: stringValue(item.title),
      publisher: stringValue(item.publisher),
      author: stringValue(item.author),
      publishedAt: stringValue(item.publishedAt),
      url: stringValue(item.url),
      finding: stringValue(item.finding),
      sourceText: stringValue(item.sourceText)
    }];
  });
}

function isCoherentSemanticCitation(value: PdpSemanticCitation): boolean {
  const sourceText = cleanSourceSignalText(value.sourceText ?? "");
  const finding = cleanSourceSignalText(value.finding ?? "");
  const title = cleanSourceSignalText(value.title ?? "");
  if (!sourceText || (!finding && !title)) return false;
  const roles = inferPdpEvidenceRoles(sourceText).roles;
  return !roles.includes("review") && !roles.includes("commerce")
    && /(?:research|study|paper|journal|article|news|press|doi|pubmed|연구|논문|학술|기사|보도|研究|論文|記事)/iu.test(sourceText);
}

function uniqueSemanticCitations(values: PdpSemanticCitation[]): PdpSemanticCitation[] {
  const seen = new Set<string>();
  return values.filter((citation) => {
    const key = cleanText([
      citation.type, citation.title, citation.publisher, citation.author,
      citation.publishedAt, citation.url, citation.finding, citation.sourceText
    ].filter(Boolean).join(" ")).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSemanticMetricClaims(values: PdpSemanticMetricClaim[]): PdpSemanticMetricClaim[] {
  const seen = new Set<string>();
  return values.filter((claim) => {
    const key = cleanText([
      claim.label,
      claim.subject,
      claim.value,
      claim.unit,
      claim.metric,
      claim.direction,
      claim.timing,
      claim.baseline,
      claim.comparator,
      claim.period,
      claim.sample,
      claim.method,
      claim.institution,
      claim.evidenceGroup,
      claim.sentence,
      claim.sourceText
    ].filter(Boolean).join(" ")).toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueSemanticIngredientBenefitLinks(values: PdpSemanticIngredientBenefitLink[]): PdpSemanticIngredientBenefitLink[] {
  const seen = new Set<string>();
  return values.filter((link) => {
    const key = cleanText([
      link.ingredient,
      link.benefit,
      link.effect,
      link.sentence,
      link.sourceText
    ].filter(Boolean).join(" ")).toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasOutcomeLanguage(value: string): boolean {
  return /benefit|effect|support|help|improve|care|hydration|moisture|barrier|firm|elastic|texture|효능|효과|개선|케어|보습|수분|장벽|탄력|피부결/i.test(value);
}

function createOcrSentenceDiagnostics(items: OcrSentenceInsightInput[], locale: PdpGeoLocale): PdpGeoOcrSentenceDiagnostic[] {
  const grouped = new Map<string, { text: string; imageUrls: string[]; intents: OcrSentenceCategory[] }>();

  for (const item of items) {
    const key = item.text.toLowerCase();
    const existing = grouped.get(key) ?? { text: item.text, imageUrls: [], intents: [] };
    if (item.imageUrl) {
      existing.imageUrls = unique([...existing.imageUrls, item.imageUrl]);
    }
    existing.intents = uniqueCategories([...existing.intents, item.category]);
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map((item) => ({
      text: item.text,
      imageUrls: item.imageUrls.length > 0 ? item.imageUrls : undefined,
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
  if (intents.includes("metric")) {
    fields.push("Product.additionalProperty[Reported details]", "Product.description", "FAQPage.mainEntity");
  }
  return unique(fields);
}

function geoUseForOcrSentence(intents: OcrSentenceCategory[], _locale: PdpGeoLocale): string {
  const hasIngredient = intents.includes("ingredient");
  const hasBenefit = intents.includes("benefit") || intents.includes("effect");
  const hasUsage = intents.includes("usage");
  const hasReview = intents.includes("review");
  const hasMetric = intents.includes("metric");

  if (hasMetric && hasIngredient) {
    return "ingredient_metric_evidence";
  }
  if (hasMetric) {
    return "metric_evidence";
  }
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
  return ocrTextCandidates(source).flatMap((candidate) => inferOcrSentenceCategories(candidate.text).map((category) => ({
    text: candidate.text,
    imageUrl: candidate.imageUrl,
    category,
    keywords: extractOcrKeywords(candidate.text)
  })));
}

function ocrTextCandidates(source: unknown): OcrTextCandidateInput[] {
  const roots = [
    getByPath(source, "sourceExtraction.ocr"),
    getByPath(source, "sourceExtraction.images"),
    getByPath(source, "ocr"),
    getByPath(source, "images"),
    getByPath(source, "aiAnalysis.ocr")
  ].filter((value) => value !== undefined);

  return uniqueOcrTextCandidates(roots
    .flatMap(readOcrTextsFromNode)
    .flatMap((candidate) => splitOcrTextIntoSemanticSentences(candidate.text).map((text) => ({
      text: cleanOcrSentence(text),
      imageUrl: candidate.imageUrl
    })))
    .filter((candidate) => isUsefulOcrSentence(candidate.text)))
    .slice(0, 80);
}

function readOcrTextsFromNode(value: unknown): OcrTextCandidateInput[] {
  const results: OcrTextCandidateInput[] = [];

  const collect = (node: unknown, key?: string, imageUrl?: string, depth = 0) => {
    if (depth > 8) {
      return;
    }
    // Structured sentence insights are consumed above with their explicit
    // provenance. Re-reading their text as unscoped OCR would erase a review
    // role and could promote review-only wording into product facts.
    if (key && /sentenceInsights?/i.test(key)) {
      return;
    }
    const scopedImageUrl = isRecord(node) ? ocrImageUrlFromRecord(node) ?? imageUrl : imageUrl;
    if (Array.isArray(node) && key && /lines?|blocks?|paragraphs?|sentences?|textBlocks?/i.test(key)) {
      const joined = flattenTextValues(node)
        .filter((text) => !isUrlLikeText(text))
        .join("\n");
      if (joined) {
        results.push({ text: joined, imageUrl: scopedImageUrl });
      }
      return;
    }
    if (typeof node === "string") {
      const text = cleanOcrRawText(htmlToText(node));
      if (!text || isUrlLikeText(text)) {
        return;
      }
      if (!key || /(?:text|ocr|line|block|paragraph|sentence|caption|description|body|fullText|rawText|recognizedText|copy)/i.test(key) || text.includes("\n")) {
        results.push({ text, imageUrl: scopedImageUrl });
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => collect(item, String(index), scopedImageUrl, depth + 1));
      return;
    }

    if (isRecord(node)) {
      Object.entries(node).forEach(([childKey, childValue]) => collect(childValue, childKey, scopedImageUrl, depth + 1));
    }
  };

  collect(value);

  return results;
}

function uniqueOcrTextCandidates(values: OcrTextCandidateInput[]): OcrTextCandidateInput[] {
  const seen = new Set<string>();
  return values.filter((candidate) => {
    const text = cleanText(candidate.text);
    const key = `${text.toLowerCase()}:${candidate.imageUrl ?? ""}`;
    if (!text || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function ocrImageUrlFromRecord(value: Record<string, unknown>): string | undefined {
  return [
    value.imageUrl,
    value.sourceImage,
    value.sourceImageUrl,
    value.sourceUrl,
    value.src,
    value.url
  ].map(stringValue).find((candidate): candidate is string =>
    Boolean(candidate && !candidate.startsWith("data:") && (/^https?:\/\//i.test(candidate) || candidate.includes("#")))
  );
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
  const maxLength = isFullIngredientList(text) ? fullIngredientListTextLimit : 700;
  if (text.length < 8 || text.length > maxLength || isUrlLikeText(text) || isOcrFootnote(text) || isLikelyVisualImageDescription(text)) {
    return false;
  }
  if (/^\d+(?:\.\d+)?\s*(?:ml|mL|oz|fl\.?\s*oz)$/i.test(text)) {
    return false;
  }
  return /[A-Za-z가-힣]/.test(text);
}

function isLikelyVisualImageDescription(value: string): boolean {
  const text = cleanText(value);
  const lower = text.toLowerCase();
  const visualTerms = /(product\s+shot|pack\s*shot|model|modeling|person\s+applying|applying\s+(?:a\s+)?(?:skincare\s+)?product|applies product|face shot|lifestyle|thumbnail|hero image|visual|image|photo|bottle|tube|jar|package|packaging|facial cleanser)/i;
  const ocrTextSignals = /(ingredients?:|how to use|directions?|after\s+\d|agreed|clinical|result|%|water\s*\/\s*aqua|glycerin|niacinamide|retinol|peptide|ceramide|hyaluronic|extract|성분|전성분|사용법|효과|개선|수분|보습|장벽|피지|탄력|주름)/i;

  if (!visualTerms.test(text) || ocrTextSignals.test(text)) {
    return false;
  }

  const commaParts = text.split(",").map((part) => part.trim()).filter(Boolean);
  return commaParts.length >= 2 || lower.split(/\s+/).length <= 18;
}

function isFullIngredientList(value: string): boolean {
  const text = cleanText(value);
  if (/^(?:ingredients?|전성분|全成分)\s*:?\s*/i.test(text) && text.replace(/^(?:ingredients?|전성분|全成分)\s*:?\s*/i, "").length >= 12) {
    return true;
  }

  const commaCount = (text.match(/,/g) ?? []).length;
  if (commaCount < 8) {
    return false;
  }

  const englishMatches = text.match(/\b(?:water|aqua|eau|glycerin|glycol|sodium|potassium|cocoyl|cocoate|betaine|acrylates?|peg-\d+|chloride|edta|extract|fragrance|parfum|limonene|benzoate|hydroxide|caprylyl|capryl|citrus|niacinamide|retinol|panthenol|ceramide|hyaluronic|butylene)\b/gi) ?? [];
  const koreanMatches = text.match(/정제수|글리세린|글라이콜|다이올|오일|추출물|애씨드|알코올|세라마이드|판테놀|콜레스테롤|카보머|토코페롤|레시틴|왁스|폴리머|크로스폴리머|글루코|스쿠알란|실리카|이디티에이|트로메타민|잔탄검|하이드로|메티콘|스테아레이트|카프릴|팔미|라우릭|미리스틱|올레익|만니톨|소듐|포스페이트|락톤/gi) ?? [];
  const matches = new Set([...englishMatches, ...koreanMatches].map((match) => match.toLowerCase()));
  return matches.size >= 5;
}

function isOcrFootnote(value: string): boolean {
  return /^\s*[*※]/.test(value.trim()) || /원료적\s*특성에\s*한함/.test(value);
}

function isUrlLikeText(value: string): boolean {
  return /^(?:https?:\/\/|data:image\/|\/)/i.test(value.trim()) || /\.(?:jpe?g|png|webp|gif|avif|svg)(?:\?|$)/i.test(value.trim());
}

function inferOcrSentenceCategories(text: string, _keywords: string[] = [], explicitCategory?: string): OcrSentenceCategory[] {
  const explicit = normalizeOcrCategory(explicitCategory);
  const categories: OcrSentenceCategory[] = explicit && isOcrExplicitCategoryAllowedForText(text, explicit) ? [explicit] : [];
  if (explicit === "review") {
    return ["review"];
  }
  const route = classifyOcrRoutingContext(text);

  if (route === "cross-sell-routine") {
    return categories.includes("usage") && isUsageInstruction(text) ? ["usage"] : [];
  }
  if (route === "ingredient-list") {
    return ["ingredient"];
  }

  const inferred = inferPdpEvidenceRoles(text);
  if (inferred.roles.includes("ingredient")) categories.push("ingredient");
  if (inferred.roles.includes("benefit")) categories.push("benefit");
  if (inferred.roles.includes("effect")) categories.push("effect");
  if (inferred.roles.includes("usage")) categories.push("usage");
  if (inferred.roles.includes("review")) categories.push("review");
  if (inferred.roles.includes("metric")) categories.push("metric");

  if (route === "metric-evidence" && !inferred.roles.includes("metric")) {
    return categories.filter((category) => category !== "metric");
  }

  return uniqueCategories(categories);
}

function classifyOcrRoutingContext(text: string): "cross-sell-routine" | "metric-evidence" | "ingredient-list" | "general" {
  const normalized = cleanSourceSignalText(text);
  if (isFullIngredientList(normalized)) {
    return "ingredient-list";
  }
  if (isCrossSellRoutineText(normalized)) {
    return "cross-sell-routine";
  }
  if (isMetricEvidenceText(normalized)) {
    return "metric-evidence";
  }
  return "general";
}

function isCrossSellRoutineText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const stepCount = (text.match(/\bstep\s*\d+\b|단계\s*\d+|\d+\s*단계/gi) ?? []).length;
  const productTypeCount = new Set((text.match(/\b(?:serum|cream|toner|water|cleanser|foam|oil|essence|ampoule|mask|lotion|eye\s*cream|스킨|토너|세럼|크림|클렌저|폼|오일|에센스|앰플|마스크|ローション|クリーム|セラム|美容液|化粧水)\b/gi) ?? [])
    .map((token) => token.toLowerCase().replace(/\s+/g, " "))).size;
  const routineHeading = /\b(?:complete\s+your\s+ritual|routine|regimen|ritual|step\s*\d|단계|루틴|リチュアル|ルーティン)\b/i.test(text);

  return routineHeading && stepCount >= 2 && productTypeCount >= 2;
}

function isMetricEvidenceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const hasMetric = /%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|사용자|참여자|대상|clinical|study|self-assess|instrumental|agreed|showed|改善|評価/i.test(text);
  const hasUsageAction = hasExplicitUsageAction(text);
  const startsWithTimingMetric = /^(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\b/i.test(text);

  return hasMetric && (startsWithTimingMetric || isKoreanMetricEvidenceText(text) || !hasUsageAction);
}

function isKoreanMetricEvidenceText(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const timing = /(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|(?:\d+(?:\.\d+)?\s*(?:시간|일|주).{0,20})?(?:\d+\s*회\s*)?(?:사용|도포|측정)\s*후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)/;
  const metricOutcome = /(?:\d+(?:\.\d+)?\s*(?:%|배).{0,40}(?:회복|개선|감소|증가)|(?:회복|개선|감소|증가).{0,40}\d+(?:\.\d+)?\s*(?:%|배))/;
  const studyContext = /(?:임상|인체\s*적용|시험|테스트|결과|ex\s*vivo|in\s*vitro|Tape\s*Stripping|외부자극)/i;

  return /[가-힣]/.test(text)
    && (/%|\d+(?:\.\d+)?\s*배/.test(text))
    && (metricOutcome.test(text) || (timing.test(text) && studyContext.test(text)));
}

function isOcrExplicitCategoryAllowedForText(text: string, category: OcrSentenceCategory): boolean {
  if (category === "usage") {
    return isUsageInstruction(text);
  }
  if (category === "ingredient") {
    return isIngredientSignal(text);
  }
  if (category === "benefit") {
    return isConciseBenefitSignal(text);
  }
  if (category === "effect") {
    return isEffectSignal(text);
  }
  if (category === "review") {
    // The structured category is provenance; review keyword fragments do not
    // need to repeat a lexical "review" marker in every atomic text value.
    return true;
  }
  return true;
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
  if (/metric|claim|result|수치|지표|결과/.test(normalized)) {
    return "metric";
  }
  return undefined;
}

function extractOcrKeywords(text: string): string[] {
  const keywords = [
    /히알루론산|하이알루론산/i.test(text) ? "히알루론산" : undefined,
    /징크|zinc/i.test(text) ? "징크" : undefined,
    /세라마이드/i.test(text) ? "세라마이드" : undefined,
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

function textCandidatesByKeyOutsideReview(source: unknown, pattern: RegExp): string[] {
  const results: string[] = [];
  const reviewContainer = /(?:reviews?|reviewItems?|reviewInfo|reviewAnalysis|reviewSignals?|reviewSummar(?:y|ies)|ratingSummary|testimonials?|customerReviews?|customerReviewAnalysis|userReviews?|후기|리뷰)/iu;
  const visitCandidate = (value: unknown, path: string[], depth: number) => {
    if (depth > 8) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitCandidate(item, [...path, String(index)], depth + 1));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, childValue] of Object.entries(value)) {
      const nextPath = [...path, key];
      const insideReview = nextPath.some((part) => reviewContainer.test(part));
      if (!insideReview && pattern.test(key)) {
        results.push(...flattenTextValues(childValue));
      }
      visitCandidate(childValue, nextPath, depth + 1);
    }
  };
  visitCandidate(source, [], 0);
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
  const normalized = normalizeSourceUsageInstruction(value);
  if (normalized.length < 8 || normalized.length > 260) {
    return false;
  }
  if (isQuestionLikeSourceText(normalized) || isNonInstructionUsageText(normalized) || /사용\s*적합|테스트를\s*완료|임산부|영유아|어린이|논코메도제닉/i.test(normalized)) {
    return false;
  }
  if (isCrossSellRoutineText(normalized)) {
    return false;
  }
  if (isSensoryOnlyUsageInstruction(normalized)) {
    return false;
  }

  if (isEvidenceOnlyUsageCandidate(normalized)) {
    return false;
  }
  if (isConciseStandaloneUsageStep(normalized)) {
    return true;
  }
  if (normalized.length < 18 || normalized.split(/\s+/).length < 4) {
    return false;
  }

  return hasExplicitUsageAction(normalized);
}

function isConciseStandaloneUsageStep(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (text.length < 8 || text.length > 80 || !hasExplicitUsageAction(text)) {
    return false;
  }
  return (
    /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|pump|take)\b/i.test(text)
    && /\b(?:water|face|skin|hands?|palms?|neck|product|amount|toner|cleanser|serum|cream|essence|step)\b/i.test(text)
  ) || (
    hasKoreanInstructionVerb(text)
    && /(?:적당량|손에|물과\s*함께|거품|얼굴|미온수|헹구|화장솜|덜어|펴\s*바르|흡수)/.test(text)
  );
}

function isSensoryOnlyUsageInstruction(value: string): boolean {
  return /\b(?:take\s+a\s+deep\s+breath|inhale|scent|fragrance|aroma)\b/i.test(value)
    && !/\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|skin|face|neck)\b/i.test(value);
}

function isEvidenceOnlyUsageCandidate(value: string): boolean {
  const normalized = cleanSourceSignalText(value);
  if (isSafetyOrTestClaimUsageCandidate(normalized)) {
    return true;
  }
  if (/^(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\b/i.test(normalized)) {
    return true;
  }
  if (isKoreanMetricEvidenceText(normalized)) {
    return true;
  }
  const looksLikeEvidence = /%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?)\b|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|평점|리뷰\s*\d|사용자|참여자|대상|clinical|study|self-assess|instrumental|agreed|showed|test(?:ed)?|delivers?|helps?|supports?|improves?|boosts?|strengthens?|leaves?|leaving|visible|visibly/i.test(normalized);

  return looksLikeEvidence && !hasExplicitUsageAction(normalized);
}

function isNonInstructionUsageText(value: string): boolean {
  return isReviewLikeUsageCandidate(value)
    || isSafetyOrTestClaimUsageCandidate(value)
    || isSuitabilityOrComparisonUsageCandidate(value);
}

function isSuitabilityOrComparisonUsageCandidate(value: string): boolean {
  const text = cleanSourceSignalText(value);
  const suitability = /(?:적합할?\s*수|추천할?\s*수|suitable|recommended|better\s+suited|appropriate)/i.test(text);
  const comparison = /(?:보다|대비|비교|compared\s+(?:with|to)|rather\s+than|versus|\bvs\.?\b)/i.test(text);
  const directDirection = /(?:적당량|손에|얼굴(?:에|과)|목(?:에|과)|펴\s*바르|발라\s*주세요|사용하세요|apply|dispense|massage|rinse|pat|press|smooth)/i.test(text);
  return suitability && comparison && !directDirection;
}

function isReviewLikeUsageCandidate(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (isKoreanCustomerReviewNarrativeUsageLeak(text)) {
    return true;
  }
  if (!/[가-힣]/.test(text) || hasConcreteKoreanUsageAction(text)) {
    return false;
  }
  return /(?:타\s*제품|사용해\s*봤|사용해봤|사용했|썼는데|써\s*봤|써봤|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)/i.test(text);
}

function isKoreanCustomerReviewNarrativeUsageLeak(value: string): boolean {
  const text = cleanSourceSignalText(value);
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  return /(?:^|\s)[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text)
    || /(?:아직\s*본격적으로|워낙\s*평|평이\s*좋|기대가\s*많|기대되|고객\s*리뷰|후기|리뷰)/u.test(text)
    || /(?:구매했|구매\s*했|구매했어요|필요해서\s*구매|배송|포장|도착했|득템|저렴한\s*가격|쓰기\s*전부터|쓰기도\s*전부터|기분이\s*정말\s*좋)/u.test(text)
    || /(?:초등학생|딸|아들|남편|어머니|엄마|가족)[^.!?。！？]{0,80}(?:구매|필요|사용|쓰|선크림)/u.test(text)
    || /(?:느낌이네요|느낌입니다|좋습니다|좋네요|좋아요|같아요|같습니다)\s*$/u.test(text) && !hasKoreanInstructionVerb(text);
}

function isSafetyOrTestClaimUsageCandidate(value: string): boolean {
  const text = cleanSourceSignalText(value);
  return /(?:테스트|시험)\s*완료|사용성\s*테스트|피부\s*자극\s*테스트|피부\s*테스트|안자극|하이포알러지|논코메도제닉|민감\s*피부\s*대상|소아와?\s*피부\s*테스트|소아\s*피부\s*테스트/i.test(text)
    || /(?:patch\s*test|patch\s*testing|dermatologist[-\s]?tested|hypoallergenic|non[-\s]?comedogenic|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should|test\s+on\s+a\s+small\s+area)/i.test(text);
}

function hasConcreteKoreanUsageAction(value: string): boolean {
  return hasKoreanInstructionVerb(value);
}

function normalizeSourceUsageInstruction(value: string): string {
  let normalized = stripLeadingUsageMeasurementLabels(cleanSourceSignalText(value)
    .replace(/\bStep\s+\d+\b[.:)]?\s*/gi, "")
    .replace(/^\d+[.)]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim());
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
  const normalized = cleanSourceSignalText(prefix);
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

function hasExplicitUsageAction(value: string): boolean {
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump)\b|なじませ|塗布|使(?:う|い)/i.test(value)
    || hasKoreanInstructionVerb(value)
    || /^\s*use\b/i.test(value)
    || /(?:^|[.;,]\s*)then\s+use\b/i.test(value)
    || /\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b/i.test(value);
}

function hasKoreanInstructionVerb(value: string): boolean {
  const text = cleanSourceSignalText(value);
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|사용\s*(?:해|하세요|합니다|십시오|한다|하시|할\s*때)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
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
  if (isRatingSummaryText(normalized)) {
    return false;
  }
  if (/^(review|rating|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }

  return normalized.split(/\s+/).length >= 4 || /[가-힣ぁ-んァ-ン]/.test(normalized);
}

function isRatingSummaryText(value: string): boolean {
  const normalized = cleanText(value)
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:rating|평점|評価)?\s*\d(?:\.\s*\d+)?\s*(?:\/\s*5)?\s*(?:stars?)?\s+\d[\d,]*\s+(?:reviews?|ratings?|리뷰|후기)$/i.test(normalized)
    || /^(?:rating|평점|評価)\s+\d(?:\.\s*\d+)?\s*(?:\/\s*5)?$/i.test(normalized);
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
