import type {
  PdpAvailabilityToken,
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
  PdpProductVariantSignal,
  PdpReturnPolicySignal,
  PdpShippingSignal,
  PdpSemanticFacts,
  PdpSemanticCitation,
  PdpSemanticIngredientBenefitLink,
  PdpSemanticMetricClaim,
  PdpSourceTextMeta
} from "./types";
import { isPublishableImageUrl } from "./contracts/image-source-contract";
import { annotatedFigureScopes, measurementFigures, statesOnlyFiguresOf } from "./contracts/metric-statement-contract";
import { localizeProductTypeForLocale, productTypeFromName } from "./contracts/product-type-contract";
import { isKoreanCompleteSentence } from "./contracts/sentence-form-contract";
import {
  hasConcreteKoreanUsageAction,
  hasKoreanInstructionVerb,
  isSafetyOrTestClaimUsage,
  isStitchedMarketingPageDump
} from "./contracts/usage-contract";
// 계사 이형태는 문장 형태 계약이 소유한다. 기존 소비처(content-planner,
// final-proofreader)가 계속 이 모듈에서 읽을 수 있도록 다시 내보낸다.
export {
  KOREAN_COPULA_ENDING_FORMS,
  KOREAN_COPULA_POLITE_PRESENT_ENDINGS
} from "./contracts/sentence-form-contract";
import {
  KOREAN_COPULA_ENDING_FORMS
} from "./contracts/sentence-form-contract";
import { filterCurrentProductUsageInstructions } from "./product-scope";
import {
  normalizeAvailabilityToken,
  normalizeItemConditionToken,
  normalizeMonetaryAmountForCurrency,
  normalizeReturnFeesToken,
  normalizeReturnMethodToken,
  normalizeReturnPolicyCategoryToken,
  sanitizeCountryCodeValue,
  sanitizeDayCountValue,
  sanitizeGtinValue,
  sanitizeSkuValue
} from "./schema-values";


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
  // GEO-128 계약에서 variants는 자체 필드(variant 1건의 JSON 문자열 배열)가
  // 되었으므로 options 후보에서 제외한다 — JSON 원문이 옵션으로 새는 것을 막는다.
  options: ["geoProduct.options", "product.options", "options", "sizes"],
  benefits: ["geoProduct.benefits", "benefits", "product.benefits", "categorizedProductInfo.benefits", "sections.BENEFITS", "sections.benefits"],
  effects: ["geoProduct.effects", "effects", "product.effects", "categorizedProductInfo.effects", "sections.EFFECTS", "sections.effects", "clinicalResults"],
  ingredients: ["geoProduct.ingredients", "ingredients", "keyIngredients", "ingredientHighlights", "categorizedProductInfo.ingredients", "sections.INGREDIENTS", "sections.ingredients"],
  usage: ["geoProduct.usage", "usage", "howToUse", "how_to_use", "directions", "categorizedProductInfo.usage", "sections.HOW TO USE", "sections.howToUse"],
  faq: ["geoProduct.faq", "faq", "faqs", "product.faq", "categorizedProductInfo.faq"],
  reviews: ["geoProduct.reviews.items", "reviews.items", "reviewItems", "reviews", "customerReviewAnalysis.items", "reviewInfo.items"],
  rating: ["geoProduct.reviews.rating", "reviews.rating", "rating", "aggregateRating.ratingValue", "reviewInfo.reviewScope", "customerReviewAnalysis.rating"],
  reviewCount: ["geoProduct.reviews.reviewCount", "reviews.reviewCount", "reviewCount", "aggregateRating.reviewCount", "reviewInfo.reviewCount", "customerReviewAnalysis.reviewCount"],
  breadcrumbs: ["breadcrumbs", "breadcrumb", "breadcrumbList", "categoryPath"],
  dateModified: ["geoProduct.dateModified", "product.dateModified", "product.updatedAt", "product.updated_at", "dateModified", "updatedAt", "updated_at", "modifiedAt", "lastModified"]
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
  // GEO-128: sku/gtin/availability/variants는 아래에서 구조 보존 필드로
  // 수집되어 JSON-LD에 매핑된다. tags/seoTitle/seoDescription 및 metafields의
  // 구조 보존은 여전히 보류 상태다(metafields→sourceTexts 주입 유지).
  const contractVariants = parseContractVariants(source);
  const commerceIdentity = extractCommerceIdentity(source);
  const commerceTrust = extractCommerceTrust(source);
  const dateModified = extractSourceDateModified(source, mapped.strings("dateModified"));
  const metafieldSourceTexts = contractMetafieldTexts(source);
  const ocrSentenceInsights = sentenceInsightItems(source);
  const name = first([
    ...mapped.strings("name"),
    ...textCandidatesByKey(source, /name|title|상품명|prodName|onlineProdName/i)
  ]) ?? "Untitled product";
  const semanticFacts = normalizeSemanticFacts(source, ocrSentenceInsights, name);
  const looseFaq = faqFromLooseQuestionAnswerTexts(source);
  const ocrImageConfidenceByUrl = buildOcrImageConfidenceMap(source);
  const sourceTextEntries: SourceTextEntry[] = [
    ...ocrSentenceInsights
      .filter((item) => isUsefulSourceText(item.text))
      .map((item) => ({ text: item.text, meta: ocrSourceTextMetaFromInsight(item, ocrImageConfidenceByUrl) })),
    ...toSourceTextEntries(textArray(getByPath(source, "sourceTexts"))),
    ...toSourceTextEntries(textArray(getByPath(source, "geoProduct.sourceTexts"))),
    // metafields는 key(namespace.key)가 의미의 절반이므로 값만 남기는 allStrings
    // 재귀 수집 대신 "key: value" 문자열로 주입해 key를 보존한다(GEO-128).
    ...toSourceTextEntries(metafieldSourceTexts),
    ...toSourceTextEntries(textArray(getByPath(source, "sourceExtraction.ocr.textBlocks"))),
    ...toSourceTextEntries(allStrings(source).filter(isUsefulSourceText).slice(0, 80)),
    ...toSourceTextEntries(mapped.strings("description")),
    ...toSourceTextEntries(mapped.strings("benefits")),
    ...toSourceTextEntries(mapped.strings("effects")),
    ...toSourceTextEntries(mapped.strings("ingredients")),
    ...toSourceTextEntries(mapped.strings("usage"))
  ];
  const uniqueSourceTextEntriesResult = uniqueSourceTextEntries(sourceTextEntries
    .map((entry) => ({ text: cleanSourceSignalText(entry.text), meta: entry.meta }))
    .filter((entry) => isUsefulSourceText(entry.text))).slice(0, 120);
  const sourceTexts = uniqueSourceTextEntriesResult.map((entry) => entry.text);
  // 텍스트로 키잉한다. sourceTexts는 이미 텍스트 단위로 중복 제거되어 키가 유일하고,
  // 뒤따르는 재필터(filterCurrentProductUsageInstructions 등)가 항목을 떨어뜨려도
  // 남은 텍스트의 계보가 그대로 따라온다.
  const sourceTextMeta = Object.fromEntries(
    uniqueSourceTextEntriesResult
      .filter((entry): entry is { text: string; meta: PdpSourceTextMeta } => entry.meta !== undefined)
      .map((entry) => [entry.text, entry.meta])
  );

  // An explicitly routed description is authoritative even when it is short.
  // Falling through to an arbitrary longer `body` used to let nested review
  // copy replace valid product descriptions such as "A face serum.".
  const mappedDescriptions = mapped.strings("description");
  const description = first(mappedDescriptions) ?? firstLong(
    textCandidatesByKeyOutsideReview(source, /description|desc|summary|linePromo/i)
  );
  const inferredBrand = first([...mapped.strings("brand"), ...textCandidatesByKey(source, /brand|vendor|maker|manufacturer/i)]);
  const brand = context.hints?.brand ?? normalizeMachinePrefixedBrand(inferredBrand, name, source, context.sourceUrl);
  // A source that names its own form ("… 크림 미스트") states its category even
  // when it exposes no category field. Leaving it unset made the run publish a
  // Product.category derived from that same name while holding no evidence
  // atom for it, so copy naming the category could not be supported. An
  // explicit source category always wins; this only fills the gap.
  const category = context.hints?.category ?? first([
    ...mapped.strings("category"),
    ...textCandidatesByKey(source, /categoryName|categoryPath|taxonomy|productType|product_type/i)
  ].filter(isCategorySignal)) ?? productTypeFromProductName(name, context.hints?.locale);
  // Serialized metadata entries state their role in the key and the fact in
  // the value (benefit::firming). The key is an explicit role routing — the
  // same trust contract as fieldMapping — so the parsed values skip vocabulary
  // role re-inference and pass only the trusted-signal quality gates. The raw
  // strings stay in sourceTexts as retrieval context.
  const metadataSignals = structuredMetadataSignals(sourceTexts);
  const directBenefitSignals = unique([
    ...normalizeFieldSignals([...semanticFacts.benefits, ...mapped.strings("benefits")], "benefit"),
    ...selectTrustedMappedRoleSignals([...mapped.strings("benefits"), ...metadataSignals.benefits], "benefit")
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
    ...selectTrustedMappedRoleSignals([...mapped.strings("effects"), ...metadataSignals.effects], "effect")
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
  const usage = dedupePdpUsageInstructions(normalizeFieldSignals([...semanticFacts.usageSteps, ...mapped.strings("usage"), ...sentenceInsightTexts(ocrSentenceInsights, "usage"), ...sectionTexts(source, categoryKeywords.usage), ...classifiedProductSections(source, "usage")], "usage")).slice(0, 8);
  // Preserve a broader evidence pool for semantic FAQ planning. Public FAQ is
  // still capped after buyer-intent ranking; clipping here by source order can
  // otherwise discard high-value suitability or life-stage questions that
  // appear later in the PDP source.
  const faq = uniqueFaq([...mapped.faq(), ...faqFromUnknown(source), ...looseFaq]).slice(0, 16);
  const reviews = normalizeReviews(source, mapped);
  // A URL the source itself cut short is dropped here rather than downstream:
  // it is a source defect, and carrying it into the graph only to have schema
  // validation repair it reports a generation problem the generator never had.
  const images = unique(mapped.strings("images")
    .flatMap((value) => splitPotentialList(value))
    .map((value) => absolutizeUrl(value, context.sourceUrl))
    .filter(isPublishableImageUrl)).slice(0, 80);
  // variant의 title/options를 내부 options로 파생 주입해 기존 옵션 기반
  // 로직(variant 비교·라벨)이 계약 변경 후에도 계속 동작하게 한다(GEO-128).
  const options = unique([
    ...mapped.strings("options").flatMap(splitPotentialList),
    ...contractVariants.flatMap((variant) => [
      ...(variant.title ? [variant.title] : []),
      ...variant.options
    ])
  ]).slice(0, 16);
  const priceRaw = first(mapped.strings("price"))
    ?? first(contractVariants.map((variant) => variant.price));
  const semanticMetricTexts = semanticFacts.metricClaims.flatMap(selectAtomicMetricClaimTexts);
  const representedMetricSources = new Set(semanticFacts.metricClaims
    .flatMap((claim) => [claim.sentence, claim.sourceText])
    .filter((value): value is string => Boolean(value))
    .map((value) => cleanSourceSignalText(value).toLocaleLowerCase()));
  // A measured claim may not be built out of a customer's own sentence, and the
  // test for that is where the text came from, not how it is worded. A
  // well-formed first-person review ("제가 4주 써보니 수분감은 2배로 늘었습니다")
  // is a grammatically perfect measured statement — no structural predicate can
  // separate it from a lab result, and separating it by vocabulary is the
  // defect this whole predicate exists to remove. Provenance answers it
  // outright, and the rule for what counts as review scope already has one home
  // ({@link allStringsOutsideReview}, {@link isReviewProvenanceRecord}).
  const reviewScopedSources = reviewScopedSourceTextKeys(source);
  const metrics = unique([
    ...semanticMetricTexts,
    ...sourceTexts
      .filter((value) => !reviewScopedSources.has(sourceTextIdentityKey(value)))
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
    sku: commerceIdentity.sku,
    gtin: commerceIdentity.gtin,
    availability: commerceIdentity.availability,
    itemCondition: commerceIdentity.itemCondition,
    priceValidUntil: commerceTrust.priceValidUntil,
    returnPolicy: commerceTrust.returnPolicy,
    shipping: commerceTrust.shipping,
    dateModified,
    variants: contractVariants.length > 0 ? contractVariants : undefined,
    price: priceRaw ? (() => {
      const currency = first(mapped.strings("currency"))?.trim().toUpperCase();
      // Offer 렌더링과 동일한 통화 인지 정규화를 진단 단계에서도 적용해
      // normalizedProduct.price.amount(예: 센트 정수 21500)와 최종
      // Offer.price(215)가 어긋나지 않게 한다.
      return {
        raw: priceRaw,
        amount: (currency ? normalizeMonetaryAmountForCurrency(priceRaw, priceAmount(priceRaw), currency) : undefined) ?? priceAmount(priceRaw),
        currency: first(mapped.strings("currency"))
      };
    })() : undefined,
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
    sourceTextMeta,
    semanticFacts
  });

  evidence.push({ field: "product.name", source: "input", value: name });
  if (description) {
    evidence.push({ field: "product.description", source: "input", value: description });
  }
  if (commerceIdentity.sku) {
    evidence.push({ field: "product.sku", source: "input", value: commerceIdentity.sku });
  }
  if (commerceIdentity.gtin) {
    evidence.push({ field: "product.gtin", source: "input", value: commerceIdentity.gtin });
  }
  if (commerceIdentity.availability) {
    evidence.push({ field: "offer.availability", source: "input", value: commerceIdentity.availability });
  }
  if (contractVariants.length > 0) {
    evidence.push({
      field: "product.variants",
      source: "input",
      value: `${contractVariants.length} structured variants retained (title/options/price/sku/gtin/availability).`
    });
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
 * GEO-128 계약의 `variants`(원소가 variant 1건의 JSON 문자열, 모든 키 선택적)를
 * 구조 보존 형태로 파싱한다. 파싱에 실패한 원소는 무시한다(원문은 기존 수집
 * 경로로 남는다). 상거래 값(sku/gtin/availability)은 공유 정규화기를 통과한
 * 값만 유지한다 — 잘못된 식별자/재고 표기는 없는 것보다 해롭기 때문이다.
 */
function parseContractVariants(source: unknown): PdpProductVariantSignal[] {
  const raw = [
    getByPath(source, "variants"),
    getByPath(source, "geoProduct.variants"),
    getByPath(source, "product.variants")
  ].find(Array.isArray) as unknown[] | undefined;
  return (raw ?? []).flatMap((item) => {
    const record = typeof item === "string" ? parseJsonRecord(item) : isRecord(item) ? item : undefined;
    if (!record) {
      return [];
    }
    const soldOut = typeof record.soldOut === "boolean"
      ? record.soldOut
      : typeof record.sold_out === "boolean" ? record.sold_out : undefined;
    const availability = normalizeAvailabilityToken(record.availability)
      ?? normalizeAvailabilityToken(record.stockStatus ?? record.stock_status)
      ?? (soldOut === true ? "SoldOut" : soldOut === false ? "InStock" : undefined)
      ?? normalizeAvailabilityToken(record.available ?? record.isAvailable);
    return [{
      id: stringValue(record.id ?? record.variantId ?? record.variant_id),
      sku: sanitizeSkuValue(stringValue(record.sku ?? record.skuId ?? record.sku_id)),
      gtin: sanitizeGtinValue(record.gtin ?? record.gtin13 ?? record.gtin14 ?? record.barcode ?? record.ean),
      title: stringValue(record.title),
      options: textArray(record.options),
      price: stringValue(record.price),
      currency: stringValue(record.currency ?? record.priceCurrency ?? record.price_currency),
      availability,
      url: stringValue(record.url ?? record.link),
      image: stringValue(record.image ?? record.imageUrl ?? record.image_url)
    }];
  });
}

/**
 * Collects the P0 commerce trust layer from the input contract: price
 * validity, structured merchant return policy, and structured shipping
 * signal. Fail-closed like the commerce identity — unmappable fragments are
 * dropped whole, never partially guessed, because an inconsistent policy or
 * lead time misleads commerce surfaces.
 */
function extractCommerceTrust(source: unknown): {
  priceValidUntil?: string;
  returnPolicy?: PdpReturnPolicySignal;
  shipping?: PdpShippingSignal;
} {
  const priceValidUntil = firstDefined([
    "priceValidUntil", "geoProduct.priceValidUntil", "product.priceValidUntil", "offers.priceValidUntil"
  ].map((path) => sanitizeSchemaDateValue(getByPath(source, path), { allowFuture: true })))?.slice(0, 10);

  const policyRecord = firstDefined([
    "returnPolicy", "geoProduct.returnPolicy", "product.returnPolicy"
  ].map((path) => getByPath(source, path))) as unknown;
  let returnPolicy: PdpReturnPolicySignal | undefined;
  if (isRecord(policyRecord)) {
    const category = normalizeReturnPolicyCategoryToken(policyRecord.category ?? policyRecord.returnPolicyCategory);
    const applicableCountry = sanitizeCountryCodeValue(policyRecord.applicableCountry ?? policyRecord.country);
    const merchantReturnDays = sanitizeDayCountValue(policyRecord.merchantReturnDays ?? policyRecord.returnDays ?? policyRecord.days);
    // Google 요건: FiniteReturnWindow는 반품 가능 일수가 필수다.
    const daysSatisfied = category !== "MerchantReturnFiniteReturnWindow" || merchantReturnDays !== undefined;
    if (category && applicableCountry && daysSatisfied) {
      returnPolicy = {
        category,
        merchantReturnDays,
        returnMethod: normalizeReturnMethodToken(policyRecord.returnMethod ?? policyRecord.method),
        returnFees: normalizeReturnFeesToken(policyRecord.returnFees ?? policyRecord.fees),
        applicableCountry,
        returnPolicyCountry: sanitizeCountryCodeValue(policyRecord.returnPolicyCountry) ?? applicableCountry,
        url: stringValue(policyRecord.url ?? policyRecord.link ?? policyRecord.merchantReturnLink)
      };
    }
  }

  const shippingRecord = firstDefined([
    "shipping", "geoProduct.shipping", "product.shipping"
  ].map((path) => getByPath(source, path))) as unknown;
  let shipping: PdpShippingSignal | undefined;
  if (isRecord(shippingRecord)) {
    const destinationCountry = sanitizeCountryCodeValue(shippingRecord.destinationCountry ?? shippingRecord.country);
    const handlingDaysMin = sanitizeDayCountValue(shippingRecord.handlingDaysMin);
    const handlingDaysMax = sanitizeDayCountValue(shippingRecord.handlingDaysMax);
    const transitDaysMin = sanitizeDayCountValue(shippingRecord.transitDaysMin);
    const transitDaysMax = sanitizeDayCountValue(shippingRecord.transitDaysMax);
    const rateAmount = typeof shippingRecord.rate === "number" ? shippingRecord.rate
      : isRecord(shippingRecord.rate) && typeof shippingRecord.rate.amount === "number" ? shippingRecord.rate.amount : undefined;
    const rateCurrency = isRecord(shippingRecord.rate) ? stringValue(shippingRecord.rate.currency) : stringValue(shippingRecord.rateCurrency);
    const hasDeliveryRange = transitDaysMin !== undefined || transitDaysMax !== undefined
      || handlingDaysMin !== undefined || handlingDaysMax !== undefined;
    if (destinationCountry && hasDeliveryRange) {
      shipping = {
        destinationCountry,
        handlingDaysMin,
        handlingDaysMax,
        transitDaysMin,
        transitDaysMax,
        rate: rateAmount !== undefined && rateAmount >= 0 && rateCurrency ? { amount: rateAmount, currency: rateCurrency } : undefined
      };
    }
  }

  return { priceValidUntil, returnPolicy, shipping };
}

/**
 * Collects the explicit product-level commerce identity from the input
 * contract (GEO-128): merchant SKU, GTIN, availability, and item condition.
 * Explicit values take precedence over any downstream inference; each value
 * is accepted only after shared normalization (fail-closed).
 */
function extractCommerceIdentity(source: unknown): {
  sku?: string;
  gtin?: string;
  availability?: PdpAvailabilityToken;
  itemCondition?: ReturnType<typeof normalizeItemConditionToken>;
} {
  const skuPaths = [
    "skuId", "sku", "productCode", "prodCode", "goodsNo",
    "geoProduct.skuId", "geoProduct.sku", "product.skuId", "product.sku", "product.productCode"
  ];
  const gtinPaths = [
    "gtin", "gtin13", "gtin14", "gtin12", "gtin8", "barcode", "ean", "upc", "jan",
    "geoProduct.gtin", "geoProduct.barcode", "product.gtin", "product.barcode"
  ];
  const availabilityPaths = [
    "availability", "stockStatus", "stock_status", "saleStatus", "stockState",
    "geoProduct.availability", "product.availability", "offers.availability"
  ];
  const conditionPaths = ["itemCondition", "condition", "geoProduct.itemCondition", "product.itemCondition"];

  const sku = firstDefined(skuPaths.map((path) => sanitizeSkuValue(stringValue(getByPath(source, path)))));
  const gtin = firstDefined(gtinPaths.map((path) => sanitizeGtinValue(getByPath(source, path))));
  const availability = firstDefined(availabilityPaths.map((path) => normalizeAvailabilityToken(getByPath(source, path))))
    ?? availabilityFromStockFlags(source);
  const itemCondition = firstDefined(conditionPaths.map((path) => normalizeItemConditionToken(getByPath(source, path))));
  return { sku, gtin, availability, itemCondition };
}

/**
 * Extracts a source-provided PDP last-modified date. Fail-closed like the
 * other commerce identity values: only recognizable calendar dates from the
 * source (or an explicit field mapping) are accepted — the generation time is
 * never used, because an invented freshness signal is a misleading citation
 * gatekeeper rather than a real one.
 */
function extractSourceDateModified(source: unknown, mappedValues: string[]): string | undefined {
  // Root-level generic keys (updatedAt, lastModified, ...) may describe a DB
  // record rather than the PDP; only explicit or product-scoped paths are
  // trusted by default. Generic keys remain reachable via fieldMapping.
  const datePaths = [
    "dateModified",
    "geoProduct.dateModified", "geoProduct.updatedAt", "geoProduct.modifiedAt",
    "product.dateModified", "product.updatedAt", "product.modifiedAt"
  ];
  return firstDefined([
    ...mappedValues.map((value) => sanitizeSchemaDateValue(value)),
    ...datePaths.map((path) => sanitizeSchemaDateValue(getByPath(source, path)))
  ]);
}

/**
 * Accepts ISO-like calendar dates (`2026-08-11`, `2026.08.11`, full ISO 8601
 * datetimes) and returns an ISO 8601 string. Anything else — epoch numbers,
 * relative labels, out-of-range dates — is rejected.
 */
function sanitizeSchemaDateValue(value: unknown, options?: { allowFuture?: boolean }): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text || text.length > 40) {
    return undefined;
  }
  const match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})([Tt\s].*)?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  // Real-calendar check: reject dates like 2026-02-31 that regex ranges pass.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return undefined;
  }
  const dateOnly = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const time = match[4]?.trim();
  const normalizedTime = time ? `T${time.slice(1)}` : undefined;
  const candidate = normalizedTime && /^T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(normalizedTime)
    ? `${dateOnly}${normalizedTime}`
    : dateOnly;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  // A future "last modified" is a spam signal, not a freshness signal.
  // (priceValidUntil처럼 미래가 정상인 필드는 allowFuture로 이 검사를 건너뛴다.)
  if (!options?.allowFuture && parsed.getTime() > Date.now() + 48 * 3600 * 1000) {
    return undefined;
  }
  return candidate;
}

/** Maps common boolean stock flags to availability when no textual status exists. */
function availabilityFromStockFlags(source: unknown): PdpAvailabilityToken | undefined {
  const soldOutFlag = firstDefined(["soldOut", "isSoldOut", "sold_out", "geoProduct.soldOut", "product.soldOut"]
    .map((path) => booleanValue(getByPath(source, path))));
  if (soldOutFlag !== undefined) {
    return soldOutFlag ? "SoldOut" : "InStock";
  }
  const availableFlag = firstDefined(["available", "isAvailable", "inStock", "geoProduct.available", "product.available"]
    .map((path) => booleanValue(getByPath(source, path))));
  if (availableFlag !== undefined) {
    return availableFlag ? "InStock" : "OutOfStock";
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GEO-128 계약의 `metafields`(key는 namespace.key, 값은 사람이 읽는 문자열)를
 * "key: value" 문자열로 변환한다. allStrings 재귀 수집은 값만 남겨 key가
 * 소실되므로, key를 보존한 문자열을 sourceTexts에 주입하기 위한 것이다.
 */
function contractMetafieldTexts(source: unknown): string[] {
  const raw = [
    getByPath(source, "metafields"),
    getByPath(source, "geoProduct.metafields"),
    getByPath(source, "product.metafields")
  ].find(isRecord);
  if (!raw) {
    return [];
  }
  return Object.entries(raw).flatMap(([key, value]) => {
    const text = stringValue(value);
    return text ? [`${key}: ${text}`] : [];
  });
}

interface StructuredMetadataSignals {
  benefits: string[];
  effects: string[];
}

/**
 * A serialized metadata entry carries its meaning in two halves: the key
 * names the semantic role and the value carries the fact — `benefit::firming`
 * states that firming is a benefit. Parse the pair into role-correct atomic
 * signals instead of treating the joined string as prose. Entries whose key
 * names no product-fact role (machine categories, SEO tags, collections) are
 * left in sourceTexts as retrieval context only.
 */
function structuredMetadataSignals(texts: string[]): StructuredMetadataSignals {
  const signals: StructuredMetadataSignals = { benefits: [], effects: [] };
  for (const text of texts) {
    const entry = parseSerializedMetadataEntry(text);
    if (!entry) {
      continue;
    }
    const target = metadataKeyRoleTarget(entry.key);
    if (target) {
      signals[target].push(...entry.values);
    }
  }
  return {
    benefits: uniqueCaseInsensitive(signals.benefits),
    effects: uniqueCaseInsensitive(signals.effects)
  };
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseSerializedMetadataEntry(text: string): { key: string; values: string[] } | undefined {
  const cleaned = cleanText(text);
  const match = cleaned.match(/^([\w.-]+(?:\s[\w.-]+)?)\s*::?\s*(.+)$/);
  if (!match) {
    return undefined;
  }
  const key = (match[1] ?? "").split(".").pop()?.replace(/[_-]+/g, " ").trim().toLocaleLowerCase() ?? "";
  const values = (match[2] ?? "")
    .split(/\s*,\s*/)
    .map((value) => value.replace(/^:+\s*/, "").replace(/_+/g, " ").trim())
    .filter((value) => value.length >= 2 && value.length <= 48)
    .filter((value) => !/^\d+$/.test(value) && !/[|:]/.test(value));
  return key && values.length > 0 ? { key, values } : undefined;
}

/**
 * The key is matched by the role concept it names, not by an exhaustive
 * platform-specific key list: any key naming a benefit maps to benefits, any
 * key naming an effect, function, or feature maps to effects.
 */
function metadataKeyRoleTarget(key: string): keyof StructuredMetadataSignals | undefined {
  if (/\bbenefits?\b/.test(key)) {
    return "benefits";
  }
  if (/\b(?:effects?|functions?|features?)\b/.test(key)) {
    return "effects";
  }
  return undefined;
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
    ...textCandidatesByKeyInsideReview(source, /^(?:keywords?|키워드)$/i),
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

/** Product form stated by the name, in the wording of the requested market. */
function productTypeFromProductName(name: string, locale?: PdpGeoLocale): string | undefined {
  const productType = productTypeFromName(name);
  if (!productType) return undefined;
  return locale ? localizeProductTypeForLocale(productType, locale) : productType;
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
  const units = values
    .flatMap((value) => splitMixedEvidenceUnits(value, field))
    .map(cleanSourceSignalText);
  const normalized = field === "usage" ? normalizeUsageSignalUnits(units) : units;
  return unique(normalized.filter((value) => isAllowedFieldSignal(value, field)));
}

/**
 * Usage normalization strips leading step markers ("1.", "Step 2") as label
 * noise, but a complete explicit 1..N sequence is source-order evidence that
 * HowTo composition needs to publish a multi-step procedure, so those markers
 * are re-attached after the instruction text itself is normalized.
 */
/**
 * A leading number is a step marker when it carries an ordinal suffix
 * ("1단계", "1段階") or marker punctuation ("Step 1:", "1."). A bare number
 * followed only by a space stays ambiguous with a quantity ("2 펌프를 덜어"),
 * so it is not a marker. Detection and removal share this one definition:
 * when they disagreed, a marker form that only one side recognised was
 * stripped without its ordering being preserved, and a dose was read as a
 * step number and deleted from the instruction.
 */
const leadingUsageStepMarkerPattern = /^(?:(?:사용\s*방법|사용법|how\s*to\s*use|directions?|使い方|使用方法)\s*[.:：]?\s*)?(?:step\s*)?(\d+)\s*(?:(?:단계|段階)\s*[.):、]?\s*|[.):、]\s*)/iu;

function normalizeUsageSignalUnits(units: string[]): string[] {
  const positions = explicitUsageSequencePositions(units);
  return units.map((value, index) => {
    const normalized = normalizeSourceUsageInstruction(value);
    const position = positions.get(index);
    return position && normalized ? `${position}. ${normalized}` : normalized;
  });
}

function explicitUsageSequencePositions(units: string[]): Map<number, number> {
  const markers = units.flatMap((value, index) => {
    const match = cleanSourceSignalText(value).match(leadingUsageStepMarkerPattern);
    return match ? [{ index, position: Number(match[1]) }] : [];
  });
  // The same numbered sequence often arrives once per signal source
  // (mapped usage, semanticFacts.usageSteps, OCR insights), so accept a
  // complete ascending 1..N run repeated verbatim ([1,2,1,2]), not only a
  // single run ([1,2]). Duplicated entries collapse later via unique().
  const runLength = Math.max(0, ...markers.map((marker) => marker.position));
  const complete = markers.length >= 2
    && runLength >= 2
    && markers.length % runLength === 0
    && markers.every((marker, order) => marker.position === (order % runLength) + 1);
  return complete ? new Map(markers.map((marker) => [marker.index, marker.position])) : new Map();
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
  if (field === "benefit" || field === "effect") {
    const enumeration = splitEnumerationListUnits(text);
    if (enumeration) {
      return enumeration;
    }
  }
  const units = text
    .split(/(?:\r?\n|\s*[•●▪■]\s*|(?<=[.!?。！？])\s+(?=[\p{L}\p{N}]))/u)
    .map(cleanSourceSignalText)
    .filter(Boolean);
  return units.length > 0 ? units : [text];
}

/**
 * Text function: a comma-separated enumeration of short outcome tokens
 * ("Hydrating, Firming, Smoothing") lists atomic facts, so each token is one
 * evidence unit. Prose that merely contains commas keeps longer clauses or
 * sentence punctuation, so it never qualifies and stays one unit.
 */
function splitEnumerationListUnits(text: string): string[] | undefined {
  const parts = text
    .split(/\s*,\s*/)
    .map((part) => part.replace(/^(?:and|or|및|그리고)\s+/iu, "").trim());
  if (parts.length < 3) {
    return undefined;
  }
  const enumerable = parts.every((part) => part.length >= 2
    && part.length <= 24
    && part.split(/\s+/).length <= 3
    && !/[.!?。！？()（）:;：；]/u.test(part));
  return enumerable ? parts : undefined;
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
  return /benefit|hydration|moisture|firm|elastic|barrier|bright|soothing|comfort|wrinkle|fine lines?|plump|lifting|hypoallergenic|low[-\s]?irritation|수분|보습|장벽|탄력|진정|피부결|쿨링|붉은기|저자극|속수분|유수분|保湿|うるおい|ハリ|バリア/i.test(text);
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
    // `할인가` widened to `할인`: an offer term is an offer term whether or not
    // it is followed by 가. This list is the single source for commerce
    // vocabulary and already runs as the metric gate's preamble, so a discount
    // line drops here rather than needing the metric predicate to recognise a
    // word — which is the enumeration this reconstruction removes.
    //
    // 적립·지급률·수수료·할부·취소 are here for the same reason. `4주 후 적립률은
    // 10%입니다` passes the attribution test honestly — it really does name an
    // elapsed timepoint — and is grammatically identical to `4주 후 개선율은
    // 10%입니다`. What separates them is only what the rate is *of*, which is a
    // commerce concept, so it is this list's job and not the predicate's.
    //
    // 포인트 is deliberately absent: in cosmetics it is 포인트 메이크업 before it
    // is a loyalty point, and listing it would silently drop a real cleansing
    // measurement — the exact failure this reconstruction exists to remove.
    || /(?:add\s+to\s+(?:bag|cart)|buy\s+now|sale\s+price|regular\s+price|장바구니|구매하기|판매가|할인|쿠폰|배송|교환|반품|적립|지급률|수수료|할부|취소)/i.test(text);
}

/**
 * Safety is a sentence function: a caution, a usage restriction, or a
 * completed-verification claim ("hypoallergenic tested"). A bare property
 * term such as "hypoallergenic" or "논코메도제닉" states what the product is
 * like — a low-irritation benefit (like 저자극) — not what was verified, so
 * property vocabulary alone never classifies as safety.
 */
function isSafetyOrSuitabilityCaution(value: string): boolean {
  const text = cleanSourceSignalText(value);
  return /(?:patch\s*test|patch\s*testing|test\s+on\s+a\s+small\s+area|discontinue\s+use|avoid\s+contact|for\s+external\s+use|consult\s+(?:a|your)\s+(?:doctor|physician)|caution|warning|hypoallergenic(?:ally)?[-\s]?test(?:ed|ing|s)?\b|non[-\s]?comedogenic(?:ally)?[-\s]?test(?:ed|ing|s)?\b|dermatologist[-\s]?tested|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should)/i.test(text)
    || /(?:국소\s*부위|팔\s*안쪽|귀\s*뒤|패치\s*테스트|사용\s*전\s*테스트|이상\s*증상|사용을\s*중지|전문의와\s*상담|주의사항|외용으로만|극민감\s*(?:피부\s*)?테스트|민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트|피부\s*자극\s*테스트|피부과\s*테스트|여드름성\s*피부\s*사용\s*적합\s*테스트|알러지\s*테스트|인체\s*안자극\s*테스트|소아과\s*피부\s*테스트|하이포알러(?:지|제닉)\s*테스트|논코메도제닉\s*테스트)/u.test(text);
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

/**
 * The particles and endings that can attach to a Korean measure noun.
 *
 * Needed because a unit syllable is also an ordinary syllable: `4시간으로` is a
 * duration, `3분자` is a molecule. A unit is a unit when a word boundary or one
 * of these follows it, and the set is the closed grammatical class of Korean
 * particles — no measurable thing and no product category appears in it.
 */
const koreanParticleAfterMeasureNoun = "은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터|보다|처럼|이며|며|이고|고|간|씩|째|여|당|짜리|이나|나";

/**
 * A measure noun ends where Hangul stops or where one of its particles begins.
 *
 * The copula is deliberately not a boundary here. Admitting it read `1년입니다`
 * and `1등급입니다` as measurements, which is how a warranty term and a
 * membership tier became measured results; the units in those are real units,
 * so nothing downstream could tell them apart afterwards.
 */
const koreanMeasureNounBoundary = `(?:(?!\\p{sc=Hangul})|(?=(?:${koreanParticleAfterMeasureNoun})(?:\\P{sc=Hangul}|$)))`;

/**
 * A numeral naming a point in time rather than measuring an interval.
 *
 * A study period ("2025.07.21~2025.08.22", "2022년 12월 19일") is dense with
 * digits and day units, and none of them is a measured result. Stripped before
 * the magnitude is looked for, so a date can never be the only thing that makes
 * a sentence look measured. This is a numeric shape, not a vocabulary.
 */
const calendarPointInTimePattern =
  /\d{2,4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*월\s*\d{1,2}\s*일/gu;

/**
 * A measured magnitude: a number carrying a unit that puts it on a scale.
 *
 * The unit classes are closed, and closed for the reason that matters here —
 * they are units, not subject matter. A new product category brings new things
 * to measure (세정력, 자외선 차단 지속력, 밀착력), but never a new way of writing
 * `97.1%`. That is what separates this pattern from the outcome-word list it
 * replaces, which had to be extended for every category and silently dropped
 * the figures of every category nobody had extended it for.
 *
 * Four scales: proportion and ratio, a physical or chemical scale, a graded
 * score, and elapsed time — which is how a durability result is stated.
 *
 * The physical units are an explicit set rather than a shape, and that is a
 * deliberate choice: a unit is a closed measurement system, so the set can be
 * complete and stay complete, where an outcome-word list can only ever be
 * behind. The price of the choice is that it must actually cover the domain —
 * a dermatology endpoint left out fails exactly like a category left out of the
 * old list — so the skin-measurement units are all here: length down to the
 * corneocyte (`㎜`/`mm`/`㎛`/`μm`/`µm`/`cm`), concentration (`ppm`, `mg`), and
 * transepidermal water loss, whose unit is a compound (`g/m²h` and the ways OCR
 * writes it).
 *
 * Two scales name themselves before the number instead of after it (`pH 5.5`,
 * `SPF 50`), so they are matched in that order — a digit-then-unit pattern
 * alone never sees them. Korean puts a particle between the two (`pH는 5.5`),
 * so the same closed particle class that bounds a measure noun is admitted
 * between the scale name and its figure.
 *
 * The boundary after a unit is "no Latin letter or digit follows", not `\b`:
 * `\b` needs a word character on one side, and both `㎜` and the Korean
 * particle after it are non-word, so every symbol unit silently never matched.
 *
 * Cardinality counters (`3종`, `30명`, `2개`, `1회`) are deliberately absent:
 * they count things rather than measure them, so `3종 성분을 함유합니다` is a
 * composition statement and `30명 대상` is a sample size, neither of them a
 * result. Trade quantities (`200ml`, `7.05 oz`, `200g`, `1kg`) are absent for
 * the same reason — a package size is a specification, and
 * {@link isCommerceQuantityOrOfferText} is the gate that reads those. The
 * boundary rule is what keeps `200ml` from matching the `m` of a length unit.
 */
const latinUnitBoundary = "(?![A-Za-z0-9])";

/**
 * An area or a volume, in the three ways a page writes it: the superscript, the
 * bare digit, and the precomposed symbol. `1.2mm2`, `1.2mm²` and `1.2㎟` are one
 * measurement and are read as one — the bare digit has to be stated because the
 * unit boundary refuses a following digit.
 *
 * The bare lengths these are built from (`mm`, `cm`, `m`) are deliberately not
 * measures on their own: a bare length is how a package states its dimensions
 * (`용기 지름은 45mm입니다`, `60mm x 60mm x 150mm`), and nothing in the sentence
 * separates that from a measured one. An *area* is not a shape a package spec
 * takes, so it carries no such ambiguity. Micro- and nanometre stay measures in
 * both forms — no package is described in either.
 */
const areaOrVolumeUnitSource = "(?:(?:mm|cm|m|μm|µm|㎛|nm)(?:[²³]|[23])|㎟|㎠|㎡|㎥)";

/** Transepidermal water loss, in the forms OCR produces for `g/m²h`. */
const tewlUnitSource = "g\\s*/\\s*(?:m\\s*2|m²|㎡)\\s*[/·.]?\\s*h";

const measuredMagnitudeSource = "(?:\\d[\\d,]*(?:\\.\\d+)?\\s*(?:"
  + "[%％‰]"
  + `|배${koreanMeasureNounBoundary}`
  + "|[°˚]\\s*[CF]?|℃|℉"
  + `|(?:도|점|등급|주일|시간|분|초|일|주|개월|년)${koreanMeasureNounBoundary}`
  + `|${tewlUnitSource}`
  + `|${areaOrVolumeUnitSource}${latinUnitBoundary}`
  + `|(?:ppm|ppb|mg|㎎|㎛|μm|µm|㎚|nm|µg|μg|㎍|IU|kcal|Pa|pH)${latinUnitBoundary}`
  + `|(?:percent|points?|times|fold|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?|degrees?)${latinUnitBoundary}`
  + ")"
  + `|(?:pH|SPF)\\s*(?:${koreanParticleAfterMeasureNoun})?\\s*(?:\\p{L}{1,6}\\s+){0,2}\\d[\\d,]*(?:\\.\\d+)?)`;

const measuredMagnitudePattern = new RegExp(measuredMagnitudeSource, "iu");

/**
 * The same pattern with the copula admitted as a measure-noun boundary.
 *
 * `평점은 4.6점입니다` carries no magnitude under the ordinary boundary, because
 * the copula attaches straight to the measure noun and is not a particle. That
 * is deliberate — admitting it unconditionally read `보증 기간은 1년입니다` as a
 * measurement. But a sentence that has already named a study and a sample is
 * not a warranty term, so the copula is allowed to close a Hangul unit once the
 * attribution test is satisfied. It is a condition on the existing boundary, not
 * a second way of recognising a magnitude.
 */
const attributedMeasuredMagnitudePattern = new RegExp(
  measuredMagnitudeSource.replaceAll(
    koreanMeasureNounBoundary,
    `(?:${koreanMeasureNounBoundary}|(?=(?:${KOREAN_COPULA_ENDING_FORMS.join("|")})))`
  ),
  "iu"
);

function hasMeasuredMagnitude(text: string, attributed = false): boolean {
  const withoutCalendarDates = text.replace(calendarPointInTimePattern, " ");
  return (attributed ? attributedMeasuredMagnitudePattern : measuredMagnitudePattern).test(withoutCalendarDates);
}

/**
 * A Korean argument marked by a topic or subject particle.
 *
 * The particles are a closed grammatical class and they attach to the noun, so
 * the test is morphological: a letter — or a figure, since a percentage can
 * itself be the subject (`94%가 …`) — carrying one of them, with a word
 * boundary after. Any letter, not only Hangul: a measurement scale is routinely
 * written in Latin and takes the same particle (`pH는 5.5로 …`), and the
 * particle is what the test is reading either way. The adnominal `-은/-는` is spelled the same and is
 * admitted along with them; separating the two needs a parser, and this
 * condition only has to establish that the sentence has an argument at all.
 *
 * `generate.ts`'s `koreanCaseMarkedMeasurementPattern` reads the same particle
 * class but asks a narrower question — whether a *particular* numeral has a
 * subject stated within two words in front of it — because it decides whether
 * one refined sentence can be quoted standing alone. The two are not merged on
 * purpose: the narrower reading would drop a measurement stated inside its
 * subject ("24시간 보습 지속력이 확인되었습니다"), where the figure precedes the
 * marker rather than following it.
 */
const koreanCaseMarkedArgumentPattern = /(?:\p{L}|[\d%％)\]])(?:은|는|이|가)(?=[\s,]|$)/u;

/**
 * An English finite predicate, read from closed-class function words and from
 * inflection.
 *
 * The auxiliaries and copulas are a closed class, and the `-ed` suffix is
 * inflectional morphology; neither is domain vocabulary, so an English study
 * sentence is recognised without knowing what it measured.
 */
const englishFinitePredicateSource =
  "(?:\\b(?:is|are|was|were|be|been|being|has|have|had|does|did|can|could|will|would|shall|should|may|might|must)\\b|\\b[a-z]{3,}ed\\b)";

/**
 * An English magnitude that a finite predicate governs.
 *
 * Proximity is the whole rule, and it is what a packshot caption cannot
 * satisfy. `Ceramide 10,000 ppm Moisturizing & strengthening. skin's moisture
 * barrier For dry & weakened skin` contains both a magnitude and an `-ed` form,
 * but they belong to different fragments of a transcribed label — `weakened`
 * modifies `skin`, it does not predicate the concentration. A reported result
 * puts the two together: `93% reported …`, `Hydration improved 10%`.
 *
 * The words allowed between them are Latin-script only, so a run that switches
 * script mid-way — an OCR panel setting an English badge beside Korean caption
 * text — cannot borrow one language's verb to predicate the other's figure.
 */
const englishPredicatedMagnitudePattern = new RegExp(
  `(?:${englishFinitePredicateSource}\\s+(?:[A-Za-z0-9%.,'’-]+\\s+){0,3}?${measuredMagnitudeSource}`
  + `|${measuredMagnitudeSource}\\s+(?:[A-Za-z0-9%.,'’-]+\\s+){0,2}?${englishFinitePredicateSource})`,
  "iu"
);

/**
 * A bracketed aside at the end of a sentence, removed.
 *
 * Study context is routinely appended in brackets — `…지속됩니다 (35~55세 여성
 * 33명 인체 적용 시험).` — which leaves a bracket where the closure test looks
 * for a predicate, and reads a finished sentence as a fragment. The aside is
 * delimited, so taking it off is bracket matching; nothing here reads what is
 * inside it. Only a trailing aside is removed, because only a trailing one
 * displaces the predicate.
 */
function withoutTrailingBracketedAside(text: string): string {
  let result = text.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const trimmed = result.replace(/\s*[(\[（［【][^()\[\]（）［］【】]*[)\]）］】]\s*[.!?。！？]*\s*$/u, "").trim();
    if (trimmed === result || !trimmed) {
      break;
    }
    result = trimmed;
  }
  return result;
}

/**
 * Whether the text names who measured, when, or on whom.
 *
 * This replaces a rule that read syntactic position, and it replaces it because
 * position is evidence of syntax, never of measurement: refusing on
 * copula-complement position lost genuine results, and accepting on the same
 * position admitted `최대 할인 20%입니다`. The copula tells you how a clause is
 * built and nothing about whether anyone measured anything.
 *
 * Attribution is what a measured result has and a commerce line does not. Four
 * signals, none of them outcome vocabulary:
 *
 * - a study period, which is a date *range* — a single date is a manufacturing
 *   stamp (`제조연월 2025년 3월`), so only the range counts;
 * - an elapsed-time timepoint: a figure in a time unit standing next to one of
 *   the closed relational nouns that make it a moment (`2주 후`,
 *   `18시간 1회 도포후`). The figure is what makes it an interval someone
 *   measured over; `무료 반품 기간 7일` has the figure and no such noun, and a
 *   bare `사용 직후` has the noun and no figure;
 * - a sample, which is a figure in the counter for people.
 *
 * A legal-entity designator used to be a fourth signal and is not one any more.
 * Every 제조사 and 판매자 line carries one, so on its own it admitted any
 * commerce percentage: a company name says who sells the thing, never that
 * anyone measured it.
 *
 * All three are numerals or closed grammatical classes. None of them names a
 * thing that was measured, so no product category can fall out of this the way
 * it fell out of the outcome-word list.
 */
const measurementAttributionPatterns: RegExp[] = [
  // A study period: a date *range*. A single stamped date is a manufacturing
  // date, so only the range counts.
  /\d{2,4}\s*[.\-/년]\s*\d{1,2}[^\n]{0,12}?\s*(?:~|-|–|—|부터)[^\n]{0,20}?\d{1,2}\s*[.\-/월일]/u,
  // An elapsed-time timepoint: a figure in a time unit standing beside one of
  // the closed relational nouns that make it a moment. The figure is required —
  // a bare `사용 직후` names an occasion but measures no interval, and reading it
  // as attribution let every `구매 직후 …%` line through.
  /\d[\d,]*(?:\.\d+)?\s*(?:분|시간|일|주|주일|개월|년)[^\n]{0,8}?(?:직후|직전|후|뒤|전|동안|만에|차)/u,
  // A sample: a figure in the counter for people.
  /\d[\d,]*\s*명/u
];

function hasMeasurementAttribution(text: string): boolean {
  return measurementAttributionPatterns.some((pattern) => pattern.test(text));
}

/**
 * Whether the text states a measured result and attributes it to something.
 *
 * This is the question the old `outcome`/`evidenceFrame` word lists were
 * standing in for, asked directly. A result that has been attributed is a
 * clause: an argument, a magnitude, and a predicate that governs them. A page
 * panel has the magnitude and neither of the other two — it ends on a noun,
 * because it was never a sentence — which is why the reading is grammatical
 * rather than lexical and why it does not care what was measured.
 *
 * Korean is read by its own morphology ({@link isKoreanCompleteSentence} for
 * the predicate) after any bracketed study aside is taken off the end, and the
 * figure has to belong to somebody: either a case-marked argument is present
 * ({@link koreanCaseMarkedArgumentPattern}), or — Korean drops topics freely —
 * the sentence names who measured, when, or on whom
 * ({@link hasMeasurementAttribution}).
 *
 * English is read by its finite-verb morphology. A transcribed layout is
 * excluded up front by the marketing-chrome predicate, which also carries the
 * context-free figure run — a badge strip has no predicate between its
 * numbers, and that is what tells it apart from a sentence that quotes two.
 */
export function isAttributedMeasurementStatement(text: string): boolean {
  if (isStitchedMarketingPageDump(text)) {
    return false;
  }
  const body = withoutTrailingBracketedAside(text);
  const koreanArgument = koreanCaseMarkedArgumentPattern.test(body) || hasMeasurementAttribution(body);
  const korean = isKoreanCompleteSentence(body) && koreanArgument;
  return korean || englishPredicatedMagnitudePattern.test(body);
}

/**
 * One atomic measured claim, fit to be quoted as it stands.
 *
 * Two conditions, and both are structural: the text carries a magnitude on a
 * measurement scale, and it predicates that magnitude of something. The
 * preamble keeps the noise this gate has always had to stop — questions,
 * commerce quantities, bare figures, and the compressed OCR block that packs a
 * whole study panel into one string.
 *
 * Review-derived wording is deliberately not among them. A survey result is a
 * measurement whoever the subjects were: `재구매 의사는 92%로 나타났습니다` and
 * `평점은 4.6점으로 확인되었습니다` state the same facts as `구매 의향` and
 * `점수`, and a gate that keeps one pair and drops the other is deciding by
 * noun again — the exact defect this predicate exists to remove. Actual review
 * chatter fails on structure without any help: it carries no magnitude
 * (`재구매 의사 있어요`), or no argument for the figure to be predicated of
 * (`촉촉하고 좋아요 별점 5점 만점에 5점 주고 싶어요`).
 */
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
  const attributed = hasMeasurementAttribution(text);
  return hasMeasuredMagnitude(text, attributed) && isAttributedMeasurementStatement(text);
}

/**
 * Rejects OCR glue blocks that contain several independent measurements and a
 * shared footnote/study context. They remain available in `sourceTexts` for
 * evidence atomisation, but must not masquerade as one atomic metric claim.
 * The gate is based on linguistic structure, never on a product name or a
 * known product-specific number.
 */
export function isCompressedMultiClaimMetricBlock(value: string): boolean {
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

/**
 * Collects payload strings for loose FAQ harvesting while skipping
 * review-scoped subtrees. A question mark inside customer review copy is the
 * customer's own rhetoric, not a product Q/A — promoting it fabricates an FAQ
 * item out of experience text (FAQ Contract). Review scope is decided
 * structurally, never by content words: the container key matches the
 * review-container pattern, or the record declares the review class through
 * {@link isReviewProvenanceRecord}.
 *
 * That predicate is called rather than restated. This function used to inline a
 * `category`/`kind` test of its own, which read two of the seven fields the real
 * predicate reads — so a record shaped `{type: "review"}` or
 * `{sourceType: "testimonial"}` walked straight through, and the review
 * sentences this scope exists to hold back were held back only when the
 * container happened to be named `reviews`.
 */
/** One text's identity, for comparing the same string across two collectors. */
function sourceTextIdentityKey(value: string): string {
  return cleanSourceSignalText(value).toLocaleLowerCase();
}

/**
 * The source text that only ever appeared inside a review container.
 *
 * Computed as the complement: everything the generic collector reaches, minus
 * everything the review-skipping collector reaches. Taking the difference — as
 * opposed to re-implementing the skip — means the definition of review scope
 * stays in the one place that already owns it, and a text that occurs both
 * inside and outside a review is treated as product content, because it is.
 */
function reviewScopedSourceTextKeys(value: unknown): Set<string> {
  const outsideReview = new Set(allStringsOutsideReview(value).map(sourceTextIdentityKey));
  return new Set(allStrings(value)
    .map(sourceTextIdentityKey)
    .filter((key) => key.length > 0 && !outsideReview.has(key)));
}

function allStringsOutsideReview(value: unknown): string[] {
  const results: string[] = [];
  const collect = (node: unknown, key?: string, depth = 0) => {
    if (depth > 8) {
      return;
    }
    if (key && categoryKeywords.review.test(key)) {
      return;
    }
    if (isRecord(node) && isReviewProvenanceRecord(node)) {
      return;
    }
    if (typeof node === "string") {
      const text = cleanText(htmlToText(node));
      if (text.length > 0) {
        results.push(text);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => collect(item, String(index), depth + 1));
    } else if (isRecord(node)) {
      Object.entries(node).forEach(([childKey, childValue]) => collect(childValue, childKey, depth + 1));
    }
  };
  collect(value);
  return results;
}

function faqFromLooseQuestionAnswerTexts(source: unknown): PdpGeoFaqItem[] {
  const texts = allStringsOutsideReview(source)
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
  /** All images this sentence was transcribed from, when the source reports more than one. */
  imageUrls?: string[];
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
    const imageUrls = imageUrlsFromRecord(item);
    const keywords = flattenTextValues(item.keywords).slice(0, 10);

    if (!text) {
      return [];
    }

    return inferOcrSentenceCategories(text, keywords, category).map((inferredCategory) => ({
      text,
      imageUrl,
      imageUrls,
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
        metricClaims: insight.category === "metric"
          ? [{ sentence: insight.text, sourceText: insight.text, imageUrls: insight.imageUrls ?? (insight.imageUrl ? [insight.imageUrl] : undefined) }]
          : [],
        evidenceSentences: [insight.text],
        citations: [],
        ingredientBenefitLinks: insight.category === "ingredient" && hasOutcomeLanguage(insight.text)
          ? [{ sentence: insight.text, sourceText: insight.text, imageUrls: insight.imageUrls ?? (insight.imageUrl ? [insight.imageUrl] : undefined) }]
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
  const usageSteps = dedupePdpUsageInstructions(normalizeFieldSignals(value.usageSteps ?? [], "usage")).slice(0, 16);
  const safetyTests = unique((value.safetyTests ?? [])
    .map(cleanSourceSignalText)
    .filter((item) => inferPdpEvidenceRoles(item).roles.includes("safety")))
    .slice(0, 24);
  const skinTypes = normalizeTypedSkinTypeSignals(value.skinTypes ?? []).slice(0, 16);
  const rawMetricClaims = value.metricClaims ?? [];
  const metricClaims = uniqueSemanticMetricClaims(rawMetricClaims
    .filter(isCoherentSemanticMetricClaim)
    .map((claim) => withStudyScopeFromAnnotatingPanel(claim, rawMetricClaims)))
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

/**
 * Restores the study scope the source states for this claim's own figures.
 *
 * The extractor hands the same measurement twice: once inside the unsegmented
 * panel that also carries the footnote annotating it (`… 30명 대상 / 시험기간 …
 * / 개인차 있음`), and once as a refined sentence with the footnote gone. Only
 * the refined one survives {@link isCoherentSemanticMetricClaim}, so the scope
 * was discarded along with the panel — and the Evidence Routing Contract
 * forbids publishing a measured result without its sample, period, and caveat.
 *
 * A panel's footnote is matched to this claim through the figures it annotates:
 * the claim inherits a footnote only when every figure the claim states is one
 * the footnote explains. A panel holding two studies therefore hands each
 * claim its own footnote instead of the first one it finds.
 *
 * Only empty fields are filled. A claim the extractor already scoped keeps what
 * it was given.
 */
function withStudyScopeFromAnnotatingPanel(
  claim: PdpSemanticMetricClaim,
  claims: PdpSemanticMetricClaim[]
): PdpSemanticMetricClaim {
  if (cleanSourceSignalText(claim.sample ?? "") && cleanSourceSignalText(claim.period ?? "")) {
    return claim;
  }
  const figures = measurementFigures(cleanSourceSignalText(claim.sentence ?? claim.sourceText ?? ""));
  if (figures.size === 0) {
    return claim;
  }
  const annotating = claims
    .filter((other) => other !== claim)
    .map((other) => cleanSourceSignalText(other.sourceText ?? other.sentence ?? ""))
    .filter((text) => isCompressedMultiClaimMetricBlock(text))
    .flatMap(annotatedFigureScopes)
    .filter((panel) => statesOnlyFiguresOf(figures, panel.figures));
  // More than one footnote explaining the same figures means the reading is
  // ambiguous, and a figure as ordinary as `2배` appears in two studies of one
  // panel. Taking the first match handed a 30명 study's claim the 22명 footnote.
  // Nothing is filled rather than something wrong.
  if (annotating.length !== 1) {
    return claim;
  }
  const [scoped] = annotating;
  if (!scoped) {
    return claim;
  }
  return {
    ...claim,
    sample: cleanSourceSignalText(claim.sample ?? "") || scoped.scope.sample,
    period: cleanSourceSignalText(claim.period ?? "") || scoped.scope.period,
    caveat: cleanSourceSignalText(claim.caveat ?? "") || scoped.scope.caveat
  };
}

/**
 * The field path already establishes that these values describe an audience.
 * Canonicalize enumerated skin types instead of asking the generic lexical role
 * classifier to rediscover that role from each short token.
 */
function normalizeTypedSkinTypeSignals(values: string[]): string[] {
  return unique(values.flatMap((value) => {
    const text = cleanSourceSignalText(value);
    if (!text || isSafetyOrSuitabilityCaution(text)) return [];
    const canonical: string[] = [];
    const mappings: Array<[RegExp, string]> = [
      [/\bnormal(?:\s+skin)?\b/iu, "normal skin"],
      [/\bdry(?:\s+skin)?\b/iu, "dry skin"],
      [/\bcombination(?:\s+skin)?\b/iu, "combination skin"],
      [/\boily(?:\s+skin)?\b/iu, "oily skin"],
      [/\bsensitive(?:\s+skin)?\b/iu, "sensitive skin"]
    ];
    for (const [pattern, label] of mappings) {
      if (pattern.test(text)) canonical.push(label);
    }
    if (canonical.length > 0) return canonical;
    return inferPdpEvidenceRoles(text).roles.includes("audience") ? [text] : [];
  }));
}

/** Keeps the most complete source wording when an unmarked usage fragment is duplicated. */
export function dedupePdpUsageInstructions(values: string[]): string[] {
  const results: string[] = [];
  for (const raw of values) {
    const value = cleanSourceSignalText(raw);
    if (!value) continue;
    const key = usageInstructionDedupeKey(value);
    // The same instruction often arrives once with its explicit step marker
    // and once without (mapped usage vs OCR insight). They are one source
    // fact; keep the marker-carrying variant because it proves source order.
    const identicalIndex = results.findIndex((existing) => key && usageInstructionDedupeKey(existing) === key);
    if (identicalIndex >= 0) {
      if (hasExplicitUsageOrderMarker(value) && !hasExplicitUsageOrderMarker(results[identicalIndex] ?? "")) {
        results[identicalIndex] = value;
      }
      continue;
    }
    const conflictIndex = results.findIndex((existing) => usageInstructionsHaveContainmentOverlap(existing, value));
    if (conflictIndex < 0) {
      if (key) results.push(value);
      continue;
    }
    const existing = results[conflictIndex] ?? "";
    if (usageInstructionDedupeKey(value).length > usageInstructionDedupeKey(existing).length) {
      results[conflictIndex] = value;
    }
  }
  return results;
}

function usageInstructionsHaveContainmentOverlap(left: string, right: string): boolean {
  if (hasExplicitUsageOrderMarker(left) || hasExplicitUsageOrderMarker(right)) return false;
  const leftKey = usageInstructionDedupeKey(left);
  const rightKey = usageInstructionDedupeKey(right);
  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length > rightKey.length ? leftKey : rightKey;
  return shorter.length >= 18 && shorter.split(" ").length >= 4 && longer.includes(shorter);
}

function usageInstructionDedupeKey(value: string): string {
  return cleanSourceSignalText(value)
    .toLocaleLowerCase()
    .replace(/^(?:how\s+to\s+use|directions?|사용\s*방법|사용법)\s*[:.-]?\s*/iu, "")
    .replace(/^(?:step\s*)?\d+\s*(?:단계|段階)?[.):、]\s*/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitUsageOrderMarker(value: string): boolean {
  return /^(?:\s*(?:step\s*)?\d+[.)\s:-]|첫째|둘째|먼저|first\b|second\b|then\b|next\b)/iu.test(value);
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

/**
 * Joins a metric value and unit without duplicating the unit — source values
 * frequently already carry it (value "100%", unit "%"), which previously
 * rendered as "100%%" in evidence atoms and public copy.
 */
function joinAtomicMetricValueWithUnit(value: string | undefined, unit: string | undefined): string {
  const cleanedValue = cleanSourceSignalText(value ?? "");
  const cleanedUnit = cleanSourceSignalText(unit ?? "");
  if (!cleanedValue) {
    return cleanedUnit;
  }
  if (!cleanedUnit || cleanedValue.endsWith(cleanedUnit)) {
    return cleanedValue;
  }
  return `${cleanedValue}${cleanedUnit}`;
}

/**
 * A claim the extractor already resolved into fields — a value, what it
 * measures, and the conditions it was measured under.
 *
 * The conditions are established by the fields being present, not by their
 * wording: `timing: "사용 직후"` is a measurement condition whether or not the
 * phrase happens to contain a word some list knows. Re-deriving that from the
 * joined text is what used to drop a fully structured claim whose only context
 * field was a timing.
 */
function isStructuredAtomicMetricClaim(claim: PdpSemanticMetricClaim): boolean {
  const value = joinAtomicMetricValueWithUnit(claim.value, claim.unit);
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
  return hasMeasuredMagnitude(value) && /[\p{L}]/u.test(outcome);
}

function formatStructuredAtomicMetricClaim(claim: PdpSemanticMetricClaim): string | undefined {
  const outcome = cleanSourceSignalText(claim.label ?? claim.subject ?? claim.metric ?? "");
  const value = joinAtomicMetricValueWithUnit(claim.value, claim.unit);
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
      sourceText: stringValue(item.sourceText),
      imageUrls: imageUrlsFromRecord(item)
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
      sourceText: stringValue(item.sourceText),
      imageUrls: imageUrlsFromRecord(item)
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
      sourceText: stringValue(item.sourceText),
      imageUrls: imageUrlsFromRecord(item)
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
    fields.push("Review.reviewBody", "Product.additionalProperty", "FAQPage.mainEntity");
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
    // 한 전사의 줄 목록은 이어붙여야 한다 — 줄바꿈은 시각적 줄바꿈일 뿐이다.
    // 그러나 문장의 **목록**은 다르다. `evidenceSentences`는 서로 다른 이미지에서
    // 온 독립 문장을 모아 둔 것이므로, 줄처럼 이어붙이면 없는 인접이 생긴다 —
    // 1027 실측에서 패키지 라벨과 성분 설명 문장이 그렇게 한 문장으로 붙어
    // `Product.description`에 실렸고, 그 라벨의 수치는 제품컷의 오독이었다.
    const joinsLinesOfOneTranscription = key !== undefined
      && /lines?|blocks?|paragraphs?|textBlocks?/i.test(key)
      && !/sentences?/i.test(key);
    if (Array.isArray(node) && joinsLinesOfOneTranscription) {
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

function isValidOcrImageUrl(candidate: string | undefined): candidate is string {
  return Boolean(candidate && !candidate.startsWith("data:") && (/^https?:\/\//i.test(candidate) || candidate.includes("#")));
}

/**
 * A sentence can now be transcribed from more than one image (e.g. a claim
 * split across a hero shot and a detail crop). Prefers the plural
 * `imageUrls` list when it validates; a source that only ever emitted the
 * singular `imageUrl`/`src`/... fields still promotes to a one-element list.
 */
function imageUrlsFromRecord(value: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(value.imageUrls)) {
    const urls = value.imageUrls
      .map((entry) => (typeof entry === "string" ? entry : stringValue(entry)))
      .filter(isValidOcrImageUrl);
    if (urls.length > 0) {
      return urls;
    }
  }
  const single = ocrImageUrlFromRecord(value);
  return single ? [single] : undefined;
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
  // 앞 줄이 이어짐을 요구하면 이 줄은 그 절의 끝이다. 줄 스스로는 이어짐 표지를
  // 갖지 않는 경우가 흔하다 — "…수분 충전으로 / 탁월한 수분 지속 효과"에서 뒤
  // 줄은 명사로 끝나므로 제 형태만 보면 제목처럼 보이지만, 앞 줄의 조사가 그
  // 줄을 자기 문장 안으로 부른다. 앞 줄을 보지 않으면 이 관계를 알 수 없어,
  // 예전에는 그 자리에 오는 내용 낱말(효과·컨트롤·보습…)을 목록으로 나열해
  // 메우고 있었다.
  if (demandsFollowingLine(lines[index - 1])) {
    return false;
  }
  return isOcrBodyContinuationLine(next) || Boolean(lines[index + 2] && isOcrBodyContinuationLine(lines[index + 2] ?? ""));
}

/** 이 줄이 다음 줄을 자기 절 안으로 부르는지(조사·연결어미·관형형으로 끝나는지). */
function demandsFollowingLine(value: string | undefined): boolean {
  const text = cleanText(value ?? "");
  if (!text || /[.!?。！？]$/.test(text)) {
    return false;
  }
  return /[가-힣]/.test(text) ? continuesKoreanClause(text) : /\b(?:and|or|with|of|for|to|that|which|by|from|into|using|including)$/i.test(text);
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
    return continuesKoreanClause(text);
  }
  return /\b(?:is|are|was|were|helps?|supports?|combines?|enhances?|absorbs?|controls?|provides?|delivers?|working|for|by|that|and|of|to|from|with)\b/i.test(text)
    || /\b(?:patented|fast|rapid|skin|moisture|barrier|sebum|control|hydration|lasting|formula|technology)\b/i.test(text);
}

/**
 * 이 한국어 줄이 다음 줄로 이어지는지 — 문법으로 판정한다.
 *
 * OCR은 한 문장을 화면 폭에 맞춰 끊어 보내고, 그 줄바꿈은 시각적 줄바꿈일 뿐이다.
 * 이어짐을 내용 어휘 목록(`세라마이드로|성분으로|보습|장벽`…)으로 판정하던 탓에,
 * 목록에 없는 낱말로 끝난 줄이 제목으로 읽혔다. 1027 실측에서 `연약하고 건조해진`이
 * 제목으로 오판되어 뒤 줄과 마침표로 이어붙었고, `연약하고 건조해진. 피부 부위에
 * 미세 분사를 합니다.`라는 깨진 문장이 HowTo 1단계로 발행됐다(2단계는 사라졌다).
 *
 * 한국어는 절의 계속을 문법으로 표시한다 — 조사, 연결어미, 관형형. 어떤 상품이
 * 와도 같은 규칙이 서므로 어휘 목록을 유지할 필요가 없다.
 */
function continuesKoreanClause(value: string): boolean {
  const tail = cleanText(value).split(/\s+/).at(-1) ?? "";
  if (!tail) {
    return false;
  }
  // 여러 음절 조사·연결어미는 명사의 끝음절과 겹치지 않아 그대로 읽는다.
  if (/(?:으로|로서|로써|에서|에게|또는|이나|까지|부터|보다|처럼|같이|하여|면서|지만|이며|이고|과의|와의)$/u.test(tail)) {
    return true;
  }
  // 관형형 어미. "건조해진", "부족한", "채우는", "묶인"처럼 뒤 명사를 수식하며 이어진다.
  if (tail.length >= 3 && /(?:[은는을를]|[가-힣]ㄴ|진|한|던|는|운|워진|해진|되는|하는|있는|없는)$/u.test(tail)) {
    return true;
  }
  // 한 음절 조사는 명사의 끝음절과 형태가 같으므로("평가"의 "가") 어절이 세 음절
  // 이상일 때만 조사로 읽는다. `로`는 "징크로"·"캡슐로"·"기술로"처럼 도구·수단을
  // 표시하며 다음 절을 부르는데, 앞선 어휘 목록이 그 낱말들을 하나씩 나열해
  // 메우고 있던 자리다.
  return tail.length >= 3 && /(?:이|가|의|에|도|만|와|과|나|며|고|로)$/u.test(tail);
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

/**
 * A key like `ingredient`/`benefit` can name two very different things: a
 * structural content section (prose the page actually wrote, e.g.
 * `sections.INGREDIENTS`) or a bucket inside a classifier's/retriever's own
 * output (`ocr.keywords.ingredient`, `aiAnalysis.keywords.ingredient`,
 * `rag.chunks`). The bucket form carries no sentence context of its own — a
 * term lands in it purely because a classifier judged the word
 * ingredient-shaped, even when the word's only real occurrence on the page
 * was inside a customer review about a different product. Bare values
 * harvested from such a bucket are only trustworthy when the same term is
 * independently attested by page prose that lives outside both review
 * containers and other derived buckets; candidates matched inside a
 * structural section keep their existing trust. Shared by the deterministic
 * bootstrap (below) and the model-routed product-fact corpus
 * (product-normalizer.ts) so both recognise the same buckets as derived.
 */
export function isDerivedKeywordOrChunkKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return /(?:keyword|chunk|키워드|청크)/iu.test(normalized);
}

/**
 * A section/chunk/review record tags its own scope with a sibling field
 * (category/kind/type/…) rather than a distinctive key name — the record's
 * own keys are generic ("text", "bullets"), so only the tag value marks it as
 * customer review content. Excluding it by key name alone would miss it.
 * Shared by the deterministic bootstrap (below) and the model-routed
 * product-fact corpus (product-normalizer.ts).
 */
export function isReviewProvenanceRecord(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(([key, value]) =>
    /^(?:category|kind|role|sectionType|source|sourceType|type)$/i.test(key)
    && typeof value === "string"
    && (categoryKeywords.review.test(value)
      || /(?:customer\s*(?:experience|feedback)|testimonial|口コミ)/iu.test(value)));
}

function sectionTexts(source: unknown, pattern: RegExp): string[] {
  const direct: string[] = [];
  const derived: string[] = [];
  const visitSection = (value: unknown, path: string[], key: string | undefined, depth: number) => {
    if (depth > 8) {
      return;
    }
    if (key && pattern.test(key)) {
      const bucket = path.some(isDerivedKeywordOrChunkKey) ? derived : direct;
      bucket.push(...flattenTextValues(value));
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitSection(item, path, String(index), depth + 1));
    } else if (isRecord(value)) {
      Object.entries(value).forEach(([childKey, childValue]) =>
        visitSection(childValue, [...path, childKey], childKey, depth + 1));
    }
  };
  visitSection(source, [], undefined, 0);

  const cleanedDirect = unique(direct.map(cleanText).filter((value) => value.length > 0));
  const cleanedDerived = unique(derived.map(cleanText).filter((value) => value.length > 0));
  if (cleanedDerived.length === 0) {
    return cleanedDirect;
  }
  const proseCorpus = nonReviewNonDerivedProseTexts(source).map(normalizeEvidenceEntityText);
  const corroboratedDerived = cleanedDerived.filter((value) => {
    const normalized = normalizeEvidenceEntityText(value);
    return normalized.length > 0 && proseCorpus.some((prose) => prose.includes(normalized));
  });
  return unique([...cleanedDirect, ...corroboratedDerived]);
}

/**
 * Prose corpus used to corroborate derived-bucket keywords: every string leaf
 * of the source except those inside a review container (customer language,
 * not product fact) or a derived keyword/chunk bucket (classifier output,
 * not a quotation — corroborating one derived bucket with another would be
 * circular). Whole subtrees are pruned rather than filtered so nothing
 * beneath an excluded key ever contributes text.
 */
function nonReviewNonDerivedProseTexts(source: unknown): string[] {
  const results: string[] = [];
  const visitProse = (value: unknown, depth: number) => {
    if (depth > 8) {
      return;
    }
    if (typeof value === "string") {
      results.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visitProse(item, depth + 1));
      return;
    }
    if (!isRecord(value) || isReviewProvenanceRecord(value)) {
      return;
    }
    for (const [key, childValue] of Object.entries(value)) {
      if (categoryKeywords.review.test(key) || isDerivedKeywordOrChunkKey(key)) {
        continue;
      }
      visitProse(childValue, depth + 1);
    }
  };
  visitProse(source, 0);
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

/**
 * Collects generic keyword fields only when their full source path is rooted in
 * a review container. Product/SEO/OCR keyword bags describe the product, not
 * customer language, and must never become qualitative review evidence.
 */
function textCandidatesByKeyInsideReview(source: unknown, pattern: RegExp): string[] {
  const results: string[] = [];
  const reviewContainer = /^(?:reviews?|reviewItems?|reviewInfo|reviewAnalysis|reviewSignals?|reviewSummar(?:y|ies)|ratingSummary|testimonials?|customerReviews?|customerReviewAnalysis|userReviews?|후기|리뷰)$/iu;
  const visitCandidate = (value: unknown, path: string[], depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitCandidate(item, [...path, String(index)], depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, childValue] of Object.entries(value)) {
      const nextPath = [...path, key];
      const insideReview = path.some((part) => reviewContainer.test(part));
      if (insideReview && pattern.test(key)) {
        results.push(...flattenTextValues(childValue));
      }
      visitCandidate(childValue, nextPath, depth + 1);
    }
  };
  visitCandidate(source, [], 0);
  return unique(results.map(cleanText).filter((value) => value.length > 0));
}

/**
 * 근거 후보로 쓸 수 있는 모든 문자열. 파생 산출물은 지나친다.
 *
 * RAG 청크와 키워드 묶음은 상품 필드에서 **만들어진** 것이므로 그 자체가
 * 근거가 될 수 없다. 이 원칙은 이미 세워져 있었으나(`isDerivedKeywordOrChunkKey`,
 * 섹션 수집에만 적용) 이 수집 경로에는 빠져 있었고, 그 구멍이 발행물을 망쳤다 —
 * 청크는 서로 다른 사실을 줄바꿈으로 묶어 두는데, 인접한 무관한 줄이 한 문장으로
 * 이어붙어 `Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive
 * skin 세라마이드는 … 성분입니다.`가 만들어지고 그대로 `Product.description`에
 * 실렸다(1027 실측). 앞 절은 패키지 라벨이고 그 안의 수치는 제품컷의 오독이다.
 */
function allStrings(value: unknown): string[] {
  const results: string[] = [];
  const collect = (node: unknown, key?: string, depth = 0) => {
    if (depth > 8 || (key !== undefined && isDerivedKeywordOrChunkKey(key))) {
      return;
    }
    if (typeof node === "string") {
      results.push(cleanText(htmlToText(node)));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => collect(item, String(index), depth + 1));
    } else if (isRecord(node)) {
      Object.entries(node).forEach(([childKey, childValue]) => collect(childValue, childKey, depth + 1));
    }
  };
  collect(value);
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

/**
 * A clause the review excludes from what it recommends.
 *
 * `탄력개선이 필요한 연령대 제외 모두 만족할 제품이` recommends the product to
 * everyone but one group, and the attribute named inside that exclusion is the
 * reason the group is left out — not something the review says the product does.
 *
 * The markers are scope-exclusion function words, a closed class. No product or
 * benefit vocabulary appears here, so no category can fall out of the rule, and
 * a complaint cue cancelled by a negation (`당김이 없고`) is a separate judgement
 * that {@link ../review-sentiment} already owns.
 */
const reviewScopeExclusionPattern = /(?:제외|빼고|말고|외에는)(?![가-힣])|\bexcept\b|\bother\s+than\b|\baside\s+from\b/iu;

/**
 * A clause with the noun phrase its exclusion marker governs removed.
 *
 * The marker scopes what precedes it — `탄력개선이 필요한 연령대 제외 모두 만족할
 * 제품이` excludes the group that needs elasticity improvement, and names the
 * attribute only to say who the recommendation is not for. What follows the
 * marker is the recommendation itself and stays.
 *
 * Dropping the whole clause was too broad: `가격 말고는 다 만족합니다 보습 탄력
 * 피부결 다 좋아요` lost every keyword it states.
 */
function withoutExcludedNounPhrase(clause: string): string[] {
  const marker = clause.match(reviewScopeExclusionPattern);
  if (!marker || marker.index === undefined) {
    return [clause];
  }
  return [clause.slice(marker.index + marker[0].length)];
}

function extractReviewKeywords(text: string): string[] {
  return unique(text
    // Read each clause with its own scope. Splitting the whole body into
    // whitespace tokens separated a token from the clause that excluded it,
    // and `탄력` was then published as a use-feel the reviews mention.
    //
    // The split does not require whitespace after the punctuation: Korean
    // reviews routinely run sentences together (`좋아요.촉촉하고`), and
    // requiring it joined them into one clause whose every keyword the
    // exclusion then dropped.
    .split(/(?<=[.!?。！？])\s*|[,，]/u)
    .flatMap(withoutExcludedNounPhrase)
    .flatMap((clause) => clause.split(/[\s./|·()[\]{}<>:;!?]+/))
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

/** A sourceTexts candidate paired with its OCR provenance, before dedupe/cap. */
interface SourceTextEntry {
  text: string;
  meta?: PdpSourceTextMeta;
}

function toSourceTextEntries(texts: string[]): SourceTextEntry[] {
  return texts.map((text) => ({ text }));
}

/**
 * Mirrors `unique()`'s Set-based, first-occurrence dedupe on the cleaned text,
 * but keeps each surviving entry's meta alongside it (the first entry to
 * claim a given text wins its meta).
 */
function uniqueSourceTextEntries(entries: SourceTextEntry[]): SourceTextEntry[] {
  const seen = new Set<string>();
  const result: SourceTextEntry[] = [];
  for (const entry of entries) {
    const text = cleanText(entry.text);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push({ text, meta: entry.meta });
  }
  return result;
}

/** Confidence of the OCR transcription that produced each image, keyed by image URL. */
function buildOcrImageConfidenceMap(source: unknown): Map<string, number> {
  const map = new Map<string, number>();
  const imageTexts = getByPath(source, "sourceExtraction.ocr.imageTexts");
  if (!Array.isArray(imageTexts)) {
    return map;
  }
  for (const item of imageTexts) {
    if (!isRecord(item)) {
      continue;
    }
    const confidence = numberValue(item.confidence);
    if (typeof confidence !== "number") {
      continue;
    }
    for (const url of imageUrlsFromRecord(item) ?? []) {
      map.set(url, confidence);
    }
  }
  return map;
}

function minOcrConfidenceForImageUrls(
  imageUrls: string[] | undefined,
  confidenceByImageUrl: Map<string, number>
): number | undefined {
  let min: number | undefined;
  for (const url of imageUrls ?? []) {
    const confidence = confidenceByImageUrl.get(url);
    if (typeof confidence !== "number") {
      continue;
    }
    min = min === undefined ? confidence : Math.min(min, confidence);
  }
  return min;
}

function ocrSourceTextMetaFromInsight(
  insight: OcrSentenceInsightInput,
  confidenceByImageUrl: Map<string, number>
): PdpSourceTextMeta {
  const imageUrls = insight.imageUrls ?? (insight.imageUrl ? [insight.imageUrl] : undefined);
  return {
    imageUrls,
    ocrConfidence: minOcrConfidenceForImageUrls(imageUrls, confidenceByImageUrl)
  };
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
  if (isSafetyOrTestClaimUsage(normalized)) {
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
    || isSafetyOrTestClaimUsage(value)
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

function normalizeSourceUsageInstruction(value: string): string {
  let normalized = stripLeadingUsageMeasurementLabels(cleanSourceSignalText(value)
    .replace(/\bStep\s+\d+\b[.:)]?\s*/gi, "")
    .replace(leadingUsageStepMarkerPattern, "")
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
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump|spray|spritz)\b|なじませ|塗布|吹きかけ|使(?:う|い)/i.test(value)
    || hasKoreanInstructionVerb(value)
    || /^\s*use\b/i.test(value)
    || /(?:^|[.;,]\s*)then\s+use\b/i.test(value)
    || /\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b/i.test(value);
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
