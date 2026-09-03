import { load } from "cheerio";
import { createKeywordClassifier } from "./llm/providers";
import {
  parseSliceFragment,
  prepareImageOcrInputs,
  stripSliceFragment,
  type ImageOcrInput
} from "./llm/providers/image-slicing";
import type {
  AzureRoleDeployments,
  EmbeddingRuntimeConfig,
  ImageTextExtractionResponse,
  KeywordClassifier,
  OcrLayoutGroup,
  OcrLayoutLineRole,
  RerankerRuntimeConfig
} from "./llm/types";
import { normalizeExtractorProductProfileWithAgent } from "./product-normalizer";
import { defaultProductExtractorRagProfile } from "./rag/default-profile";
import { productExtractorRagManifest } from "./rag/manifest";
import {
  createProductExtractorRagQuery,
  retrieveProductExtractorRagDocuments,
  type ProductExtractorRagSettings
} from "./rag/retrieval";
import {
  ProductExtractionInputSchema,
  type AgentWarning,
  type ClassifiedKeyword,
  type ClassifiedSentenceInsight,
  type ExtractionEvidence,
  type FaqItem,
  type GeoKeywordGroups,
  type GeoSentenceInsight,
  type GeoProductRawData,
  type GeoSemanticFacts,
  type GeoSemanticMetricClaim,
  type GeoSemanticIngredientBenefitLink,
  type ImageOcrEvidenceRequest,
  type ImageOcrEvidenceResult,
  type KeywordCategory,
  type OcrDiagnostics,
  type OcrLayoutDiagnostics,
  type OcrLayoutDiscardReason,
  type OcrDroppedTextDiagnostic,
  type OcrExtraction,
  type OcrRelationDiagnostics,
  type OcrRelationSentenceDiagnostic,
  type OcrTargetDiagnostic,
  type OcrTextEvidence,
  type ProductContentCategory,
  type ProductContentSection,
  type ProductExtractorRagUsageDiagnostic,
  type ProductExtractorProductNormalizationSettings,
  type ProductExtractorProductNormalizer,
  type ProductExtractionInput,
  type ProductExtractionRun,
  type ProductExtractionResult,
  type ProductExtractionStageId,
  type ProductExtractionStep,
  type ProductProfile,
  type RagChunk,
  type ReviewItem,
  type ReviewSummary,
  type AiTokenUsage,
  type RuntimePipelineStep,
  type RuntimePipelineUsage
} from "./types";
import { normalizeOcrComparisonText, parseOcrBlockSections, segmentItemSentences } from "./ocr-block-structure";
import { metricClaimsFromOcrLayout } from "./ocr-layout-metrics";
import {
  ocrLayoutSections,
  stitchSlicedLayoutGroups,
  verifyOcrLayoutGroups,
  type SlicedLayoutReading
} from "./ocr-layout-relations";

/** Options for swapping model providers without changing the public input contract. */
export interface ProductExtractorOptions {
  provider?: ProductExtractionInput["aiProvider"];
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: AzureRoleDeployments;
  apiVersion?: string;
  /** Sampling temperature forwarded to model calls. Omitted from requests when undefined (model default). */
  temperature?: number;
  embedding?: EmbeddingRuntimeConfig;
  reranker?: RerankerRuntimeConfig;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
  rag?: ProductExtractorRagSettings;
  productNormalization?: ProductExtractorProductNormalizationSettings;
  customProductNormalizer?: ProductExtractorProductNormalizer;
  onProgress?: (step: ProductExtractionStep) => void;
}

const OCR_EVIDENCE_LIMIT = 80;
/**
 * Images per vision OCR request. Normal remote URLs can be batched more
 * aggressively, while sliced/data-url inputs stay small because they are dense
 * text crops and are more prone to cross-image mixing.
 */
const IMAGE_OCR_URL_BATCH_SIZE = 8;
const IMAGE_OCR_SLICE_BATCH_SIZE = 4;
const IMAGE_OCR_PREPARE_CONCURRENCY = 6;
/** Character budget per OCR classification call before the evidence is split into batches. */
const CLASSIFICATION_BATCH_CHAR_LIMIT = 14_000;
const MAX_IMAGE_OCR_TARGETS = 24;
const MAX_SCRIPT_ONLY_IMAGE_OCR_TARGETS = 12;
const MIN_CONTEXTUAL_IMAGE_OCR_SCORE = 8;
const RAW_IMAGE_CONTEXT_RADIUS = 900;
const WEAK_SEMANTIC_SUPPORT_TERMS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "제품",
  "상품",
  "상세",
  "설명",
  "근거",
  "고객",
  "선택",
  "기준",
  "image",
  "visual",
  "ocr",
  "evidence",
  "source",
  "detail"
]);

const modalNoiseSelector = [
  "[role='dialog']",
  "[aria-modal='true']",
  "[class*='modal']",
  "[id*='modal']",
  "[class*='popup']",
  "[id*='popup']",
  "[class*='overlay']",
  "[id*='overlay']",
  "[class*='backdrop']",
  "[id*='backdrop']",
  "[class*='newsletter']",
  "[id*='newsletter']",
  "[class*='klaviyo']",
  "[id*='klaviyo']",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='drawer']",
  "[id*='drawer']",
  "[class*='cart']",
  "[id*='cart']",
  "[class*='account']",
  "[id*='account']",
  "[class*='search']",
  "[id*='search']"
].join(",");

const pageChromeSelector = [
  "script",
  "style",
  "template",
  "iframe",
  "svg",
  "header",
  "nav",
  "footer",
  "[class*='header']",
  "[class*='footer']",
  "[class*='navigation']",
  "[class*='breadcrumb']",
  "[class*='menu']"
].join(",");

const pipelineSteps: Array<Pick<ProductExtractionStep, "id" | "title" | "description">> = [
  {
    id: "input",
    title: "입력 정규화",
    description: "상품 URL과 REST API 주소를 표준 실행 입력으로 검증"
  },
  {
    id: "fetch",
    title: "소스 수집",
    description: "페이지 HTML, 메타정보, JSON-LD 또는 API 응답 수집"
  },
  {
    id: "extract",
    title: "상품정보 추출",
    description: "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"
  },
  {
    id: "ocr",
    title: "OCR 문장/키워드 분석",
    description: "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류"
  },
  {
    id: "review",
    title: "리뷰 신호 추출",
    description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"
  },
  {
    id: "rag",
    title: "RAG chunk 생성",
    description: "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성"
  },
  {
    id: "json",
    title: "JSON 결과 생성",
    description: "복사 가능한 최종 JSON 아티팩트 생성"
  }
];

/** Extracts product, review, OCR keyword, and RAG-ready data from a URL or REST API. */
export async function extractProduct(
  input: ProductExtractionInput,
  options: ProductExtractorOptions = {}
): Promise<ProductExtractionRun> {
  const runtimeOptions = resolveRuntimeRagOptions(options);
  const process = createPipelineTracker(options.onProgress);
  process.start("input", "입력값을 검증하고 sourceType을 정규화합니다.");
  const parsed = ProductExtractionInputSchema.parse(input);
  process.done("input", parsed.sourceType === "restApi" ? "REST API 입력으로 정규화했습니다." : "상품 URL 입력으로 정규화했습니다.");

  if (parsed.sourceType === "restApi") {
    process.start("fetch", "REST API 응답을 수집합니다.");
    const payload = await fetchJson(parsed.source, parsed.headers);
    process.done("fetch", "REST API JSON 응답을 수집했습니다.");
    return extractProductFromApiPayload(payload, parsed.source, runtimeOptions, process);
  }

  process.start("fetch", "상품 상세 페이지 HTML을 수집합니다.");
  const html = await fetchText(parsed.source, parsed.headers);
  process.done("fetch", "페이지 HTML과 메타정보 후보를 수집했습니다.");
  return extractProductFromHtml(html, parsed.source, runtimeOptions, process);
}

/** Parses one PDP HTML document into the stable product extractor JSON contract. */
export async function extractProductFromHtml(
  html: string,
  source: string,
  options: ProductExtractorOptions = {},
  process = createPipelineTracker(options.onProgress)
): Promise<ProductExtractionRun> {
  const runtimeOptions = resolveRuntimeRagOptions(options);
  const jsonPayload = parseJsonText(html);
  if (jsonPayload) {
    return extractProductFromApiPayload(jsonPayload, source, runtimeOptions, process, "url");
  }

  process.start("extract", "DOM, meta, JSON-LD에서 상품 필드를 추출합니다.");
  const $ = load(html);
  const evidence: ExtractionEvidence[] = [];
  const warnings: AgentWarning[] = [];
  const runtimeSteps: RuntimePipelineStep[] = [];
  evidence.push({ field: "runtime.provider", source: "api", value: resolveProviderConfig(runtimeOptions).provider });
  const jsonLdNodes = readJsonLdNodes($);
  const productNode = findJsonLdNode(jsonLdNodes, "Product");
  const faqNode = findJsonLdNode(jsonLdNodes, "FAQPage");
  const clientStateData = extractClientStateProductData($, source);
  const removedNoiseCount = removeObstructiveElements($);

  const selectedName = selectProductName($, source, productNode, clientStateData);
  const name = selectedName?.value ?? "Untitled product";
  evidence.push({ field: "product.name", source: selectedName?.source ?? "dom", value: name });
  const selectedBrand = selectProductBrand($, productNode, clientStateData, name);
  const brand = selectedBrand?.value;
  if (brand) {
    evidence.push({ field: "product.brand", source: selectedBrand?.source ?? "dom", value: brand });
  }
  const embeddedProductTextBlocks = extractEmbeddedProductTextBlocks($, source, name);

  removePageChrome($);
  const bodyText = extractReadablePageText($);
  const pageTextBlocks = mergePageTextBlocks([
    ...extractPageTextBlocks($, name),
    ...embeddedProductTextBlocks,
    ...clientStateData.textBlocks
  ]).slice(0, OCR_EVIDENCE_LIMIT);

  if (removedNoiseCount > 0) {
    evidence.push({ field: "page.obstructionsRemoved", source: "dom", value: `${removedNoiseCount} modal, overlay, drawer, or chrome nodes removed before extraction.` });
  }
  if (embeddedProductTextBlocks.length > 0) {
    evidence.push({ field: "page.embeddedProductSections", source: "dom", value: `${embeddedProductTextBlocks.length} embedded product metadata sections collected from page scripts.` });
  }
  if (clientStateData.textBlocks.length > 0 || clientStateData.reviews.items.length > 0 || clientStateData.reviews.rating || clientStateData.reviews.reviewCount) {
    evidence.push({ field: "page.clientStateProductData", source: "dom", value: `${clientStateData.textBlocks.length} product sections and ${clientStateData.reviews.items.length} review signals collected from embedded client state JSON.` });
  }
  if (pageTextBlocks.length > 0) {
    evidence.push({ field: "page.scrollSections", source: "dom", value: `${pageTextBlocks.length} long-scroll product text sections collected for HTML parsing and RAG.` });
  }

  const selectedDescription = selectProductDescription(productNode, clientStateData, $, bodyText, name);
  const description = selectedDescription?.value;
  if (description) {
    evidence.push({ field: "product.description", source: selectedDescription?.source ?? "meta", value: description });
  }

  // Shopify류 실서비스 마크업은 Offer/MerchantReturnPolicy를 @graph의 별도
  // 노드로 두고 @id로만 참조하므로, 참조를 해석해야 가격·재고·반품 정책을
  // 읽을 수 있다.
  const offer = resolveJsonLdReference(jsonLdNodes, productNode?.offers);
  const price = stringValue(offer?.price) ?? clientStateData.price ?? meta($, "product:price:amount") ?? findPrice(bodyText);
  const currency = stringValue(offer?.priceCurrency) ?? clientStateData.currency ?? meta($, "product:price:currency");
  if (price) {
    evidence.push({ field: "product.price", source: offer?.price ? "jsonLd" : "dom", value: price });
  }
  const commerceTrust = extractCommerceTrustFromJsonLd(jsonLdNodes, productNode, offer, source);
  if (commerceTrust.availability) {
    evidence.push({ field: "product.availability", source: "jsonLd", value: commerceTrust.availability });
  }
  if (commerceTrust.priceValidUntil) {
    evidence.push({ field: "product.priceValidUntil", source: "jsonLd", value: commerceTrust.priceValidUntil });
  }
  if (commerceTrust.returnPolicy) {
    evidence.push({
      field: "product.returnPolicy",
      source: "jsonLd",
      value: `${commerceTrust.returnPolicy.category} (${commerceTrust.returnPolicy.merchantReturnDays ?? "-"} days, ${commerceTrust.returnPolicy.applicableCountry ?? "-"})`
    });
  }

  const images = unique([
    ...arrayValues(productNode?.image),
    ...arrayValues(productNode?.images),
    ...clientStateData.images,
    meta($, "og:image"),
    ...$("img, picture source").toArray().flatMap((node) => imageUrlsFromNode($, node, source)),
    ...extractRawImageUrls(html, source)
  ].filter(Boolean));

  const faq = extractFaq($, faqNode);
  let productBase: ProductProfile = {
    name,
    brand,
    price,
    currency,
    description,
    images,
    options: unique([
      ...extractOptions($, productNode),
      ...clientStateData.options
    ]).slice(0, 12),
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    faq,
    contentSections: []
  };
  const productBaseNormalization = await normalizeExtractorProductProfileWithAgent(
    {
      source,
      sourceType: "url",
      rawSource: {
        htmlText: bodyText,
        pageTextBlocks,
        jsonLdNodes,
        clientStateData
      },
      bootstrapProduct: productBase,
      analysisPrompt: runtimeOptions.analysisPrompt,
      ragDocuments: runtimeOptions.ragDocuments
    },
    runtimeOptions
  );
  productBase = productBaseNormalization.product;
  // 모델 정규화가 프로필을 재구성해도 소스에서 관측된 커머스 신뢰 필드는
  // 원시값 그대로 보존한다(재고·반품 조건은 재작성 대상이 아니다).
  productBase = { ...productBase, ...commerceTrust };
  appendProductNormalizationDiagnostics(productBaseNormalization, evidence, warnings, runtimeSteps, runtimeOptions);
  process.done("extract", createExtractionNormalizeMessage(productBase.name, "상품 기본정보", productBaseNormalization));

  process.start("ocr", "이미지 OCR과 이미지 대체 텍스트 후보를 문장/키워드 근거로 분류합니다.");
  const ocrDiagnosticsCollector = createOcrDiagnosticsCollector(resolveProviderConfig(runtimeOptions).provider);
  const ocr = await extractOcrKeywords($, source, productBase.name, productBase.images, runtimeOptions, warnings, runtimeSteps, (message) => {
    process.start("ocr", message);
  }, ocrDiagnosticsCollector);
  const sectionBuckets = createProductSectionBuckets(pageTextBlocks);
  process.done("ocr", `${ocr.imagesScanned}개 이미지 OCR/대체 텍스트 후보에서 OCR 문장과 키워드를 분류했습니다.`);

  process.start("review", "JSON-LD와 리뷰 영역에서 고객 표현을 추출합니다.");
  const pageReviews = extractReviews($, productNode);
  const reviews = mergeReviewSummaries(pageReviews.summary, clientStateData.reviews);
  // mergeReviewSummaries keeps the first defined value per field, so a field the
  // page did not supply is the one that came from embedded client state.
  pushReviewAggregateEvidence(
    evidence,
    reviews,
    pageReviews.ratingSource ?? (typeof clientStateData.reviews.rating === "number" ? "dom" : undefined),
    pageReviews.reviewCountSource ?? (typeof clientStateData.reviews.reviewCount === "number" ? "dom" : undefined)
  );
  const hasReviewAggregate = typeof reviews.rating === "number" || typeof reviews.reviewCount === "number";
  if (hasReviewAggregate && reviews.items.length === 0) {
    warnings.push({
      code: "REVIEW_BODIES_UNAVAILABLE",
      message: "An aggregate rating was found but no review bodies were readable in the fetched HTML. Review widgets are usually client-rendered, so review-language claims cannot be sourced from this run."
    });
  }
  process.done("review", describeReviewStep(reviews));

  process.start("rag", "상품, 리뷰, FAQ, OCR 근거를 RAG chunk로 구성합니다.");
  const keywords = mergeKeywords(reviews.keywords, ocr.extractedTexts.flatMap((item) => item.keywords));
  const ocrSentenceSignals = createOcrSentenceSignalBuckets(ocr);

  const fallbackBenefitKeywords = sectionBuckets.benefits.length === 0
    ? selectKeywordTexts([...keywords, ...keywordsFromText(bodyText, "benefit")], "benefit")
    : [];
  const fallbackEffectKeywords = sectionBuckets.effects.length === 0
    ? selectKeywordTexts([...keywords, ...keywordsFromText(bodyText, "effect")], "effect")
    : [];
  const product: ProductProfile = {
    ...productBase,
    benefits: unique([
      ...sectionBuckets.benefits,
      ...ocrSentenceSignals.benefits,
      ...fallbackBenefitKeywords
    ]).slice(0, 12),
    effects: unique([
      ...sectionBuckets.effects,
      ...ocrSentenceSignals.effects,
      ...fallbackEffectKeywords
    ]).slice(0, 12),
    ingredients: unique([
      ...sectionBuckets.ingredients,
      ...ocrSentenceSignals.ingredients
    ]).slice(0, 12),
    usage: unique([
      ...sectionBuckets.usage,
      ...ocrSentenceSignals.usage,
      ...(sectionBuckets.usage.length === 0 ? usageFromFaq(faq) : [])
    ]).slice(0, 12),
    metrics: sectionBuckets.metrics,
    contentSections: sectionBuckets.sections
  };

  if (ocr.imagesScanned === 0 && !hasOcrProviderWarning(warnings)) {
    warnings.push({
      code: "OCR_NO_IMAGE_TEXT",
      message: "No image OCR text candidates were found. Add data-ocr-text fixtures or configure a vision provider for richer extraction."
    });
  }

  const semanticFacts = semanticFactsFromExtraction(product, ocr);
  const ragChunks = await createRagChunks(source, product, reviews, ocr, runtimeOptions, runtimeSteps);
  const ocrDiagnostics = finalizeOcrDiagnostics(ocrDiagnosticsCollector, ocr, ragChunks);
  evidence.push(createOcrPipelineEvidence(ocrDiagnostics));
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const pageDateModified = extractPageDateModified($, html);
  if (pageDateModified) {
    evidence.push({ field: "product.dateModified", source: "meta", value: pageDateModified });
  }
  const result: ProductExtractionResult = {
    source,
    sourceType: "url",
    geoProduct: createGeoProductRawData(product, reviews, ocr, ragChunks, semanticFacts, pageDateModified),
    generatedAt,
    ragProfile: productExtractorRagManifest.profile
  };

  return {
    result,
    diagnostics: {
      source,
      sourceType: result.sourceType,
      process: process.snapshot(),
      evidence,
      warnings,
      runtimeUsage: createExtractorRuntimeUsage(runtimeOptions, runtimeSteps),
      ragUsage: createProductExtractorRagUsageDiagnostics(ragChunks),
      ocr: ocrDiagnostics,
      generatedAt,
      ragProfile: result.ragProfile
    }
  };
}

async function extractProductFromApiPayload(
  payload: unknown,
  source: string,
  options: ProductExtractorOptions,
  process: ProductExtractionProcessTracker,
  sourceType: ProductExtractionResult["sourceType"] = "restApi"
): Promise<ProductExtractionRun> {
  const runtimeOptions = resolveRuntimeRagOptions(options);
  process.start("extract", sourceType === "url" ? "URL이 반환한 JSON payload에서 상품 필드를 정규화합니다." : "REST API payload에서 상품 필드를 정규화합니다.");
  const sourceObject = isRecord(payload) ? payload : {};
  const productSource = isRecord(sourceObject.product) ? sourceObject.product : sourceObject;
  const reviewSource = isRecord(sourceObject.reviews) ? sourceObject.reviews : {};
  const variants = arrayRecords(productSource.variants);
  const firstVariant = variants[0];
  const description = stringValue(productSource.description) ?? htmlToText(stringValue(productSource.body_html) ?? stringValue(productSource.bodyHtml) ?? "");
  const keyedProductSections = extractKeyedProductSections(productSource);
  const apiTextCandidates = createApiTextCandidates(source, productSource, description, keyedProductSections);
  const warnings: AgentWarning[] = [];
  const runtimeSteps: RuntimePipelineStep[] = [];
  const evidence: ExtractionEvidence[] = [
    {
      field: "runtime.provider",
      source: "api",
      value: resolveProviderConfig(runtimeOptions).provider
    },
    {
      field: sourceType === "url" ? "url.jsonPayload" : "api.payload",
      source: "api",
      value: sourceType === "url" ? "URL returned JSON payload and was normalized." : "REST API payload normalized."
    }
  ];
  let product: ProductProfile = {
    name: stringValue(productSource.name) ?? stringValue(productSource.productName) ?? stringValue(productSource.title) ?? "Untitled product",
    brand: productBrandFromValue(productSource.brand) ?? productBrandFromValue(productSource.vendor) ?? productBrandFromValue(productSource.manufacturer) ?? productBrandFromValue(productSource.maker),
    price: stringValue(productSource.price) ?? stringValue(firstVariant?.price) ?? stringValue(firstObject(productSource.offers)?.price),
    currency: stringValue(productSource.currency) ?? stringValue(firstObject(productSource.offers)?.priceCurrency),
    availability: stringValue(productSource.availability) ?? stringValue(firstObject(productSource.offers)?.availability),
    itemCondition: stringValue(productSource.itemCondition) ?? stringValue(firstObject(productSource.offers)?.itemCondition),
    priceValidUntil: stringValue(productSource.priceValidUntil) ?? stringValue(firstObject(productSource.offers)?.priceValidUntil),
    returnPolicy: readMerchantReturnPolicyRecord(productSource.returnPolicy ?? firstObject(productSource.offers)?.hasMerchantReturnPolicy),
    description,
    images: unique([
      ...readImageUrls(productSource.images, source),
      ...readImageUrls(productSource.image, source)
    ]),
    options: unique([
      ...arrayValues(productSource.options),
      ...readOptionValues(productSource.options),
      ...readVariantOptions(variants)
    ]),
    benefits: unique([
      ...htmlishValues(productSource.benefits),
      ...keyedSectionTexts(keyedProductSections, "benefit")
    ]),
    effects: unique([
      ...htmlishValues(productSource.effects),
      ...keyedSectionTexts(keyedProductSections, "effect")
    ]),
    ingredients: unique([
      ...htmlishValues(productSource.ingredients),
      ...htmlishValues(productSource.keyIngredients),
      ...htmlishValues(productSource.ingredientHighlights),
      ...keyedSectionTexts(keyedProductSections, "ingredient")
    ]),
    usage: unique([
      ...htmlishValues(productSource.usage),
      ...htmlishValues(productSource.howToUse),
      ...htmlishValues(productSource.how_to_use),
      ...htmlishValues(productSource.directions),
      ...keyedSectionTexts(keyedProductSections, "usage")
    ]),
    metrics: unique([
      ...arrayValues(productSource.metrics),
      ...keyedProductSections.flatMap((section) => extractMetricPhrases(section.text))
    ]),
    faq: readFaqArray(productSource.faq),
    contentSections: createKeyedContentSections(keyedProductSections)
  };
  const productProfileNormalization = await normalizeExtractorProductProfileWithAgent(
    {
      source,
      sourceType,
      rawSource: {
        payload,
        productSource,
        keyedProductSections,
        apiTextCandidates
      },
      bootstrapProduct: product,
      analysisPrompt: runtimeOptions.analysisPrompt,
      ragDocuments: runtimeOptions.ragDocuments
    },
    runtimeOptions
  );
  product = productProfileNormalization.product;
  appendProductNormalizationDiagnostics(productProfileNormalization, evidence, warnings, runtimeSteps, runtimeOptions);
  const payloadLabel = sourceType === "url" ? "JSON" : "API";
  process.done("extract", createExtractionNormalizeMessage(product.name, `${payloadLabel} 상품정보`, productProfileNormalization));

  process.start("ocr", `${payloadLabel}이 제공한 상품 상세 텍스트를 OCR 문장/키워드 근거로 분류합니다.`);
  const ocrDiagnosticsCollector = createOcrDiagnosticsCollector(resolveProviderConfig(runtimeOptions).provider);
  const rawOcrCandidates = [
    ...arrayValues(productSource.ocrTexts).map((text, index) => ({
      imageUrl: product.images[index] ?? `${source}#image-${index + 1}`,
      text
    })),
    ...apiTextCandidates
  ];
  const imageTexts = mergeOcrCandidates(rawOcrCandidates, ocrDiagnosticsCollector.mergeStats, OCR_EVIDENCE_LIMIT);
  ocrDiagnosticsCollector.candidatesIn = rawOcrCandidates.length;
  ocrDiagnosticsCollector.candidatesOut = imageTexts.length;
  const classified = await classifyOcrCandidates(source, product.name, imageTexts, runtimeOptions, warnings, runtimeSteps, ocrDiagnosticsCollector);
  const ocr: OcrExtraction = {
    imagesScanned: imageTexts.length,
    extractedTexts: imageTexts.map((item) => {
      const keywords = mergeKeywords(
        classified.keywords.filter((keyword) => includesKeyword(item.text, keyword.keyword)),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16);

      return {
        imageUrl: item.imageUrl,
        text: item.text,
        confidence: item.confidence ?? classified.confidence,
        keywords,
        sentenceInsights: sentenceInsightsForCandidate(item, classified.sentenceInsights, keywords, classified.confidence),
        ...(item.imageUrls ? { imageUrls: item.imageUrls } : {}),
        ...(item.groups ? { groups: item.groups } : {})
      };
    })
  };
  ocrDiagnosticsCollector.relations = buildOcrRelationDiagnostics(ocr.extractedTexts, classified.semanticFacts);
  process.done("ocr", `${ocr.imagesScanned}개 OCR 근거 텍스트에서 문장과 키워드를 분류했습니다.`);

  process.start("review", "REST API 리뷰 데이터를 키워드 근거로 정규화합니다.");
  const reviewItems = readReviewArray(reviewSource.items ?? sourceObject.reviewItems);
  const reviews: ReviewSummary = {
    rating: numberValue(reviewSource.rating),
    reviewCount: numberValue(reviewSource.reviewCount),
    items: reviewItems,
    // OCR/product-copy keywords stay out of the review summary; downstream
    // keyword groups merge OCR evidence on their own.
    keywords: customerReviewKeywords(keywordsFromReviews(reviewItems))
  };
  pushReviewAggregateEvidence(evidence, reviews, "api", "api");
  if ((typeof reviews.rating === "number" || typeof reviews.reviewCount === "number") && reviewItems.length === 0) {
    warnings.push({
      code: "REVIEW_BODIES_UNAVAILABLE",
      message: "An aggregate rating was provided but the API payload contained no review bodies, so review-language claims cannot be sourced from this run."
    });
  }
  const classifiedSentenceSignals = createSentenceSignalBuckets(classified.sentenceInsights);
  const enrichedProduct: ProductProfile = {
    ...product,
    benefits: unique([
      ...product.benefits,
      ...classifiedSentenceSignals.benefits,
      ...selectKeywordTexts(mergeKeywords(classified.keywords, keywordsFromText(description ?? "", "benefit")), "benefit")
    ]).slice(0, 12),
    effects: unique([
      ...product.effects,
      ...classifiedSentenceSignals.effects,
      ...selectKeywordTexts(mergeKeywords(classified.keywords, keywordsFromText(description ?? "", "effect")), "effect")
    ]).slice(0, 12),
    ingredients: unique([
      ...product.ingredients,
      ...classifiedSentenceSignals.ingredients,
      ...selectKeywordTexts(classified.keywords, "ingredient")
    ]).slice(0, 12),
    usage: unique([
      ...product.usage,
      ...classifiedSentenceSignals.usage,
      ...selectKeywordTexts(classified.keywords, "usage")
    ]).slice(0, 12),
    metrics: unique([
      ...product.metrics,
      ...apiTextCandidates.flatMap((item) => extractMetricPhrases(item.text))
    ]).slice(0, 16),
    contentSections: uniqueContentSections([
      ...product.contentSections,
      ...createApiContentSections(apiTextCandidates, classified.keywords)
    ]).slice(0, 24)
  };
  process.done("review", describeReviewStep(reviews));
  process.start("rag", "API 상품/리뷰/OCR 근거를 RAG chunk로 구성합니다.");
  const semanticFacts = semanticFactsFromExtraction(enrichedProduct, ocr, classified.semanticFacts);
  const ragChunks = await createRagChunks(source, enrichedProduct, reviews, ocr, runtimeOptions, runtimeSteps);
  const ocrDiagnostics = finalizeOcrDiagnostics(ocrDiagnosticsCollector, ocr, ragChunks);
  evidence.push(createOcrPipelineEvidence(ocrDiagnostics));
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const payloadDateModified = extractPayloadDateModified(payload);
  if (payloadDateModified) {
    evidence.push({ field: "product.dateModified", source: "api", value: payloadDateModified });
  }
  const result: ProductExtractionResult = {
    source,
    sourceType,
    geoProduct: createGeoProductRawData(enrichedProduct, reviews, ocr, ragChunks, semanticFacts, payloadDateModified),
    generatedAt,
    ragProfile: productExtractorRagManifest.profile
  };

  return {
    result,
    diagnostics: {
      source,
      sourceType: result.sourceType,
      process: process.snapshot(),
      evidence,
      warnings,
      runtimeUsage: createExtractorRuntimeUsage(runtimeOptions, runtimeSteps),
      ragUsage: createProductExtractorRagUsageDiagnostics(ragChunks),
      ocr: ocrDiagnostics,
      generatedAt,
      ragProfile: result.ragProfile
    }
  };
}

interface ProductExtractionProcessTracker {
  start: (id: ProductExtractionStageId, message?: string) => void;
  done: (id: ProductExtractionStageId, message?: string) => void;
  snapshot: () => ProductExtractionStep[];
}

interface PageTextBlock {
  id: string;
  title: string;
  text: string;
}

interface ProductSectionBuckets {
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  sections: ProductContentSection[];
}

export interface OcrTextCandidate {
  imageUrl: string;
  text: string;
  /** Vision-model transcription confidence (0-1) when the provider reports one. */
  confidence?: number;
  /**
   * 전사와 함께 보고된 레이아웃 관계. 프로바이더가 보고하지 않으면 없으며,
   * 그때는 소비 측이 전사 줄 목록에서 관계를 복원한다.
   */
  groups?: OcrLayoutGroup[];
  /** Every source image that contributed text to this candidate (primary first). */
  imageUrls?: string[];
  /** 1-based slice position when this text came from one tall-image slice. */
  sliceIndex?: number;
  /** Total slices of the source image when sliced. */
  sliceCount?: number;
  /** Page reading-order position of the source image (0-based). */
  sourceOrder?: number;
}

interface ImageOcrTargetCandidate {
  imageUrl: string;
  score: number;
  sourceOrder: number;
  sectionKey: string;
}

interface ImageOcrContext {
  text: string;
  sectionKey: string;
  hasProductEvidenceSection: boolean;
  hasNegativeSection: boolean;
}

interface ClientStateProductData {
  textBlocks: PageTextBlock[];
  reviews: ReviewSummary;
  images: string[];
  options: string[];
  name?: string;
  brand?: string;
  description?: string;
  price?: string;
  currency?: string;
}

interface ProductTextCandidate {
  value?: string;
  source: ExtractionEvidence["source"];
  priority: number;
}

const embeddedProductSectionKeys = [
  { keys: ["benefits", "benefit"], title: "BENEFITS" },
  { keys: ["effects", "clinicalResults", "clinical_results", "results"], title: "CLINICAL RESULTS" },
  { keys: ["ingredients", "keyIngredients", "key_ingredients", "ingredientHighlights"], title: "INGREDIENTS" },
  { keys: ["howToUse", "how_to_use", "how to use", "usage", "directions", "application"], title: "HOW TO USE" }
] as const;

type CheerioInput = NonNullable<Parameters<ReturnType<typeof load>>[0]>;

function createPipelineTracker(onProgress?: ProductExtractorOptions["onProgress"]): ProductExtractionProcessTracker {
  const steps = pipelineSteps.map((step): ProductExtractionStep => ({
    ...step,
    status: "pending"
  }));

  function update(id: ProductExtractionStageId, patch: Partial<ProductExtractionStep>) {
    const index = steps.findIndex((step) => step.id === id);
    const current = steps[index];
    if (!current) {
      return;
    }

    const nextStep: ProductExtractionStep = {
      ...current,
      ...patch
    };
    steps[index] = nextStep;
    onProgress?.({ ...nextStep });
  }

  return {
    start(id, message) {
      update(id, {
        status: "running",
        message,
        startedAt: new Date().toISOString()
      });
    },
    done(id, message) {
      update(id, {
        status: "done",
        message,
        completedAt: new Date().toISOString()
      });
    },
    snapshot() {
      return steps.map((step) => ({ ...step }));
    }
  };
}

function appendProductNormalizationDiagnostics(
  application: {
    evidence: ExtractionEvidence[];
    warnings: string[];
    usage?: AiTokenUsage;
    called: boolean;
    applied: boolean;
  },
  evidence: ExtractionEvidence[],
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  options: ProductExtractorOptions
) {
  evidence.push(...application.evidence);
  warnings.push(...application.warnings.map((message) => ({
    code: "PRODUCT_NORMALIZATION_WARNING",
    message
  })));

  if (application.called) {
    runtimeSteps.push(createModelRuntimeStep(
      "final",
      "Product profile normalization/reasoning",
      options,
      "reasoning",
      application.usage,
      application.applied
        ? "Raw product source was normalized into source-backed ProductProfile fields before OCR/review/RAG extraction."
        : "Product profile normalization was called, but no source-backed field changes were accepted."
    ));
  }
}

function createExtractionNormalizeMessage(
  productName: string,
  target: string,
  application: { called: boolean; applied: boolean }
): string {
  if (application.applied) {
    return `${productName} ${target}를 정규화하고 에이전트 정규화를 반영했습니다.`;
  }
  if (application.called) {
    return `${productName} ${target}를 정규화하고 에이전트 정규화를 검토했습니다.`;
  }
  return `${productName} ${target}를 정규화했습니다.`;
}

function removeObstructiveElements($: ReturnType<typeof load>): number {
  let removedCount = 0;

  $(`${modalNoiseSelector}, [class], [id]`).each((_, node) => {
    const tokenText = nodeAttributeText($, node);
    const text = cleanText($(node).text());

    if (isLikelyObstructiveNode(tokenText, text)) {
      $(node).remove();
      removedCount += 1;
    }
  });

  return removedCount;
}

function removePageChrome($: ReturnType<typeof load>) {
  $(pageChromeSelector).remove();
}

function extractReadablePageText($: ReturnType<typeof load>): string {
  const root = $("main").first().length ? $("main").first() : $("body");
  const parts = root
    .find([
      "h1",
      "h2",
      "h3",
      "h4",
      "p",
      "li",
      "dt",
      "dd",
      "summary",
      "figcaption",
      "[itemprop='description']",
      "[class*='description']",
      "[class*='summary']"
    ].join(","))
    .toArray()
    .map((node) => cleanText($(node).text()))
    .filter((text) => text.length > 0);

  return cleanText((parts.length > 0 ? parts.join(". ") : root.text()));
}

function extractPageTextBlocks($: ReturnType<typeof load>, productName: string): PageTextBlock[] {
  const root = $("main").first().length ? $("main").first() : $("body");
  const candidates = root
    .find([
      "section",
      "article",
      "details",
      "summary",
      "h2",
      "h3",
      "h4",
      "button[aria-controls]",
      "[role='button'][aria-controls]",
      "[data-section-type]",
      "[data-testid*='accordion']",
      "[data-testid*='pdp']",
      "[class*='benefit']",
      "[class*='ingredient']",
      "[class*='ritual']",
      "[class*='result']",
      "[class*='faq']",
      "[class*='accordion']",
      "[class*='pdp']",
      "[id*='benefit']",
      "[id*='ingredient']",
      "[id*='how-to-use']",
      "[id*='howtouse']"
    ].join(","))
    .toArray()
    .map((node, index) => {
      const heading = sectionHeading($, node) || `Page section ${index + 1}`;
      const text = sectionText($, node, heading);
      return {
        id: `page-section-${index + 1}`,
        title: heading,
        text,
        score: scoreProductText(text, productName),
        headingPriority: isSectionHeadingText(heading) ? 1 : 0,
        sectionCount: countSectionHeadingOccurrences(text)
      };
    })
    .filter((item) => item.text.length >= 24 && item.score > 0 && isProductEvidenceCandidate(item.title, item.text))
    .sort((a, b) => b.headingPriority - a.headingPriority || a.sectionCount - b.sectionCount || b.score - a.score || b.text.length - a.text.length);

  const seen = new Set<string>();
  const blocks: PageTextBlock[] = [];

  for (const candidate of candidates) {
    const candidateText = stripSectionTitle(candidate.title, candidate.text);
    const normalized = normalizeFingerprint(candidateText);

    if (
      candidateText.length < 12 ||
      seen.has(normalized) ||
      blocks.some((block) => {
        const blockText = stripSectionTitle(block.title, block.text);
        return blockText.includes(candidateText) || candidateText.includes(blockText);
      })
    ) {
      continue;
    }

    seen.add(normalized);
    const chunkLimit = isFullIngredientList(candidateText) ? 3000 : 920;
    for (const [chunkIndex, chunk] of chunkText(candidateText, chunkLimit).entries()) {
      blocks.push({
        id: `${candidate.id}-${chunkIndex + 1}`,
        title: candidate.title,
        text: chunk
      });
      if (blocks.length >= 18) {
        return blocks;
      }
    }
  }

  if (blocks.length > 0) {
    return blocks;
  }

  const fallbackText = extractReadablePageText($);
  return chunkText(fallbackText, 920).slice(0, 8).map((text, index) => ({
    id: `page-section-fallback-${index + 1}`,
    title: `Page section ${index + 1}`,
    text
  }));
}

function extractEmbeddedProductTextBlocks($: ReturnType<typeof load>, source: string, productName: string): PageTextBlock[] {
  const snippets = extractEmbeddedProductSnippets($, source, productName);
  const blocks: PageTextBlock[] = [];

  for (const snippet of snippets) {
    for (const section of embeddedProductSectionKeys) {
      for (const value of extractJsPropertyStringValues(snippet, section.keys)) {
        const text = htmlToText(value) ?? cleanText(value);

        if (text.length < 24 || !isProductEvidenceCandidate(section.title, text)) {
          continue;
        }

        blocks.push({
          id: `embedded-product-${blocks.length + 1}`,
          title: section.title,
          text
        });
      }
    }
  }

  return mergePageTextBlocks(blocks);
}

function extractEmbeddedProductSnippets($: ReturnType<typeof load>, source: string, productName: string): string[] {
  const handle = productHandleFromSource(source);
  const snippets: string[] = [];
  const objectPatterns = [
    /theme\.products\.update\(\s*\{/g,
    /theme\.products\.list\[[^\]]+\]\s*=\s*\{/g,
    /window\.SwymProductInfo\.product\s*=\s*\{/g
  ];

  for (const node of $("script").toArray()) {
    const scriptText = $(node).html() ?? $(node).text();

    if (!/benefits?|ingredients?|howToUse|how_to_use|directions|clinicalResults|clinical_results/i.test(scriptText)) {
      continue;
    }

    for (const pattern of objectPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(scriptText)) !== null) {
        const objectStart = scriptText.indexOf("{", match.index);
        const snippet = readBalancedObjectLiteral(scriptText, objectStart);

        if (snippet && objectMatchesProduct(snippet, handle, productName)) {
          snippets.push(snippet);
        }
      }
    }
  }

  return unique(snippets);
}

function readBalancedObjectLiteral(text: string, objectStart: number): string | undefined {
  if (objectStart < 0 || text[objectStart] !== "{") {
    return undefined;
  }

  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(objectStart, index + 1);
      }
    }
  }

  return undefined;
}

function objectMatchesProduct(snippet: string, handle: string | undefined, productName: string): boolean {
  const handles = extractJsPropertyStringValues(snippet, ["handle"]);
  const titles = extractJsPropertyStringValues(snippet, ["title", "name"]);
  const normalizedProductName = normalizeFingerprint(productName);

  if (handle && handles.some((item) => item === handle)) {
    return true;
  }

  return normalizedProductName.length > 0 && titles.some((item) => normalizeFingerprint(item) === normalizedProductName);
}

function selectProductName(
  $: ReturnType<typeof load>,
  source: string,
  productNode: Record<string, unknown> | undefined,
  clientStateData: ClientStateProductData
): ProductTextCandidate | undefined {
  const handle = productHandleFromSource(source);
  const pageCandidates: ProductTextCandidate[] = [
    { value: stringValue(productNode?.name), source: "jsonLd", priority: 78 },
    { value: clientStateData.name, source: "dom", priority: 82 },
    { value: meta($, "og:title"), source: "meta", priority: 92 },
    { value: meta($, "twitter:title"), source: "meta", priority: 90 },
    { value: cleanText($("h1").first().text()), source: "dom", priority: 88 },
    { value: cleanText($("title").first().text()), source: "dom", priority: 84 }
  ];
  const handleCandidate = productNameCandidateFromHandle(handle, pageCandidates);
  const candidates = handleCandidate ? [...pageCandidates, handleCandidate] : pageCandidates;
  let best: ProductTextCandidate | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const value = cleanProductNameCandidate(candidate.value);
    if (!value || !isLikelyProductName(value)) {
      continue;
    }

    const score = candidate.priority + scoreProductNameAgainstHandle(value, handle);
    if (score > bestScore) {
      best = { ...candidate, value };
      bestScore = score;
    }
  }

  return best;
}

function selectProductBrand(
  $: ReturnType<typeof load>,
  productNode: Record<string, unknown> | undefined,
  clientStateData: ClientStateProductData,
  productName: string
): ProductTextCandidate | undefined {
  const domBrand = selectDomBrandCandidate($, productName);
  const candidates: ProductTextCandidate[] = [
    { value: productBrandFromValue(productNode?.brand), source: "jsonLd", priority: 94 },
    { value: clientStateData.brand, source: "dom", priority: 90 },
    { value: meta($, "product:brand"), source: "meta", priority: 88 },
    { value: meta($, "brand"), source: "meta", priority: 84 },
    { value: meta($, "og:brand"), source: "meta", priority: 82 },
    domBrand ? { value: domBrand, source: "dom", priority: 80 } : { value: undefined, source: "dom", priority: 0 },
    { value: bracketBrandCandidateFromProductName(productName), source: "dom", priority: 62 }
  ];
  let best: ProductTextCandidate | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const value = cleanBrandCandidate(candidate.value, productName);
    if (!value || !isLikelyBrandName(value, productName)) {
      continue;
    }

    const score = candidate.priority + scoreBrandCandidate(value, productName);
    if (score > bestScore) {
      best = { ...candidate, value };
      bestScore = score;
    }
  }

  return best;
}

function productBrandFromValue(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) {
    return direct;
  }
  if (Array.isArray(value)) {
    return firstDefined(value.map(productBrandFromValue));
  }
  if (isRecord(value)) {
    return firstDefined([
      stringValue(value.name),
      stringValue(value.brandName),
      stringValue(value.brandNm),
      stringValue(value.title),
      stringValue(value.label)
    ]);
  }
  return undefined;
}

function selectDomBrandCandidate($: ReturnType<typeof load>, productName: string): string | undefined {
  const candidates = [
    ...$("a[href*='brand'], a[href*='Brand'], a[href*='brands'], [class*='brand'], [class*='Brand'], [data-brand], [data-brand-name]")
      .toArray()
      .flatMap((node) => [
        cleanText($(node).text()),
        cleanText($(node).attr("data-brand") ?? ""),
        cleanText($(node).attr("data-brand-name") ?? ""),
        cleanText($(node).attr("aria-label") ?? "")
      ]),
    ...$("script[type='application/ld+json']").toArray().flatMap((node) => {
      const parsed = parseJsonText($(node).text());
      return parsed === undefined ? [] : [productBrandFromValue(readNestedBrandValue(parsed))];
    })
  ].filter((value): value is string => Boolean(value));

  return candidates
    .map((value) => cleanBrandCandidate(value, productName))
    .filter((value): value is string => value !== undefined && isLikelyBrandName(value, productName))
    .sort((a, b) => scoreBrandCandidate(b, productName) - scoreBrandCandidate(a, productName))[0];
}

function readNestedBrandValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || !isRecord(value) && !Array.isArray(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = readNestedBrandValue(child, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (value.brand !== undefined) {
    return value.brand;
  }
  for (const child of Object.values(value)) {
    const found = readNestedBrandValue(child, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function bracketBrandCandidateFromProductName(productName: string): string | undefined {
  const tokens = Array.from(cleanText(productName).matchAll(/\[([^\]]{1,36})\]/g))
    .map((match) => cleanText(match[1] ?? ""))
    .filter(Boolean);
  if (tokens.length < 2) {
    return undefined;
  }
  const candidate = tokens[0];
  return candidate && !isSkuOrCommerceQualifier(candidate) ? candidate : undefined;
}

function cleanBrandCandidate(value: string | undefined, productName: string): string | undefined {
  const text = cleanText(value ?? "")
    .replace(/\s+\|\s+.*$/, "")
    .replace(/\s+[–—-]\s+.*$/, "")
    .replace(/^brand\s*[:：]\s*/i, "")
    .trim();
  if (!text || text.length > 60 || normalizeFingerprint(text) === normalizeFingerprint(productName)) {
    return undefined;
  }
  return text;
}

function isLikelyBrandName(value: string, productName: string): boolean {
  const text = cleanText(value);
  if (text.length < 2 || text.length > 60 || isNonProductCommerceText(text) || isReviewEvidenceText(text) || isSkuOrCommerceQualifier(text)) {
    return false;
  }
  const normalized = normalizeFingerprint(text);
  if (!normalized || normalized === normalizeFingerprint(productName)) {
    return false;
  }
  if (/^(?:brand|brands?|manufacturer|maker|vendor|seller|store|shop|category|home|product|상품|브랜드|제조사|판매자)$/i.test(text)) {
    return false;
  }
  return true;
}

function isSkuOrCommerceQualifier(value: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)|%|\+|[₩$€£¥]|(?:^|[\s-])(?:set|kit|bundle|refill|mini|trial|sample|gift|limited|special|online|exclusive|new|best|sale|coupon|discount)(?:$|[\s-])|(?:소용량|대용량|리필|기획|세트|증정|한정|온라인|단독|할인|쿠폰)/i.test(cleanText(value));
}

function scoreBrandCandidate(value: string, productName: string): number {
  const normalized = normalizeFingerprint(value);
  const normalizedName = normalizeFingerprint(productName);
  let score = 0;
  if (normalizedName.includes(normalized)) {
    score += 16;
  }
  if (/^[\p{L}\p{N}\s&'.-]+$/u.test(value)) {
    score += 4;
  }
  if (value.length <= 24) {
    score += 3;
  }
  return score;
}

function productNameCandidateFromHandle(
  handle: string | undefined,
  candidates: ProductTextCandidate[]
): ProductTextCandidate | undefined {
  const handleTerms = productHandleTerms(handle);
  if (handleTerms.length < 2) {
    return undefined;
  }

  const handleName = titleCaseHandleTerms(handleTerms);
  const normalizedHandle = normalizeFingerprint(handleTerms.join(" "));
  const hasExpandedHandleCandidate = candidates.some((candidate) => {
    const value = cleanProductNameCandidate(candidate.value);
    const normalizedValue = value ? normalizeFingerprint(value) : "";
    return normalizedValue.startsWith(`${normalizedHandle} `);
  });

  return hasExpandedHandleCandidate ? { value: handleName, source: "url", priority: 80 } : undefined;
}

function selectProductDescription(
  productNode: Record<string, unknown> | undefined,
  clientStateData: ClientStateProductData,
  $: ReturnType<typeof load>,
  bodyText: string,
  productName: string
): ProductTextCandidate | undefined {
  const candidates: ProductTextCandidate[] = [
    { value: stringValue(productNode?.description), source: "jsonLd", priority: 74 },
    { value: clientStateData.description, source: "dom", priority: 82 },
    { value: meta($, "description"), source: "meta", priority: 88 },
    { value: meta($, "og:description"), source: "meta", priority: 86 },
    { value: firstLongText(bodyText), source: "dom", priority: 70 }
  ];
  let best: ProductTextCandidate | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const value = cleanText(candidate.value ?? "");
    if (value.length < 20 || isNonProductCommerceText(value)) {
      continue;
    }

    const score = candidate.priority + scoreProductDescriptionForProduct(value, productName);
    if (score > bestScore) {
      best = { ...candidate, value };
      bestScore = score;
    }
  }

  return best;
}

function cleanProductNameCandidate(value: string | undefined): string | undefined {
  const text = cleanText(value ?? "");
  if (text.length === 0) {
    return undefined;
  }

  const withoutSiteSuffix = text
    .replace(/\s+\|\s+.*$/, "")
    .replace(/\s+[–—-]\s+(?:ExampleLuxe|Korean Skincare|Official Store|Official Site).*$/i, "");
  return cleanText(withoutSiteSuffix) || undefined;
}

function scoreProductNameAgainstHandle(name: string, handle: string | undefined): number {
  const handleTerms = productHandleTerms(handle);
  if (handleTerms.length === 0) {
    return 0;
  }

  const normalizedName = normalizeFingerprint(name);
  const normalizedHandle = normalizeFingerprint(handleTerms.join(" "));
  if (normalizedName === normalizedHandle) {
    return 180;
  }

  const matchedTerms = handleTerms.filter((term) => normalizedName.includes(term));
  if (matchedTerms.length === handleTerms.length) {
    return 160 + matchedTerms.length * 4;
  }
  if (matchedTerms.length >= Math.ceil(handleTerms.length * 0.6)) {
    return 86 + matchedTerms.length * 6;
  }

  return matchedTerms.length * 6;
}

function scoreProductDescriptionForProduct(description: string, productName: string): number {
  const normalizedDescription = normalizeFingerprint(description);
  const productTerms = normalizeFingerprint(productName)
    .split(" ")
    .filter((term) => term.length >= 4);
  const matchedTerms = productTerms.filter((term) => normalizedDescription.includes(term)).length;
  const productScore = matchedTerms * 18;
  const careScore = hasProductCareSignal(description) ? 28 : 0;
  const reviewPenalty = isReviewEvidenceText(description) ? 12 : 0;

  return productScore + careScore - reviewPenalty;
}

function productHandleTerms(handle: string | undefined): string[] {
  if (!handle) {
    return [];
  }

  const decoded = safeDecodeURIComponent(handle);
  return unique(normalizeFingerprint(decoded)
    .split(" ")
    .filter((term) => term.length >= 3 && !/^\d+$/.test(term)));
}

function titleCaseHandleTerms(terms: string[]): string {
  return terms
    .map((term) => term.charAt(0).toUpperCase() + term.slice(1))
    .join(" ");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function productHandleFromSource(source: string): string | undefined {
  try {
    const pathParts = new URL(source).pathname.split("/").filter(Boolean);
    const productsIndex = pathParts.findIndex((part) => part.toLowerCase() === "products");
    return productsIndex >= 0 ? pathParts[productsIndex + 1] : undefined;
  } catch {
    return undefined;
  }
}

function extractJsPropertyStringValues(text: string, keys: readonly string[]): string[] {
  const values: string[] = [];

  for (const key of keys) {
    const matcher = new RegExp(`(?:^|[,{\\s])["']?${escapeRegExp(key)}["']?\\s*:`, "gi");
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(text)) !== null) {
      let valueStart = matcher.lastIndex;

      while (/\s/.test(text[valueStart] ?? "")) {
        valueStart += 1;
      }

      const quoted = readQuotedJsString(text, valueStart);
      if (quoted) {
        values.push(quoted.value);
        matcher.lastIndex = quoted.end;
      }
    }
  }

  return unique(values.map(cleanText).filter(Boolean));
}

function readQuotedJsString(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start];

  if (quote !== "\"" && quote !== "'" && quote !== "`") {
    return undefined;
  }

  let raw = "";
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      raw += `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) {
      return {
        value: decodeJsStringEscapes(raw),
        end: index + 1
      };
    }

    raw += char;
  }

  return undefined;
}

function decodeJsStringEscapes(value: string): string {
  return value.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|["'`\\/bfnrtv0])/g, (match, escape) => {
    if (escape.startsWith("u{")) {
      const codePoint = Number.parseInt(escape.slice(2, -1), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (escape.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    if (escape.startsWith("x")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }

    const simpleEscapes: Record<string, string> = {
      "\"": "\"",
      "'": "'",
      "`": "`",
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0"
    };

    return simpleEscapes[escape] ?? match;
  });
}

function mergePageTextBlocks(blocks: PageTextBlock[]): PageTextBlock[] {
  const seen = new Set<string>();
  const merged: PageTextBlock[] = [];

  for (const block of blocks) {
    const text = cleanText(block.text);
    const fingerprint = normalizeFingerprint(`${block.title}:${text}`);

    if (text.length === 0 || seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    merged.push({
      ...block,
      text
    });
  }

  return merged;
}

function extractClientStateProductData($: ReturnType<typeof load>, source: string): ClientStateProductData {
  const states = readClientStateJson($);
  const productRecords = states.flatMap((state) => collectProductStateRecords(state));
  const scopedProductRecords = productRecordsForSource(productRecords, source);
  const scopedSections = uniqueContentSections(scopedProductRecords.flatMap(extractKeyedProductSections));
  const allSections = uniqueContentSections(states.flatMap(extractKeyedProductSections));
  const sections = scopedSections.length > 0 ? scopedSections : allSections;
  const reviews = mergeReviewSummaries(...states.map((state) => extractClientStateReviews(state)));
  const scopedImages = unique(scopedProductRecords.flatMap((record) => readClientStateImages(record, source)));
  const scopedOptions = unique(scopedProductRecords.flatMap(readClientStateOptions)).filter(isProductOptionText);

  return {
    textBlocks: contentSectionsToPageTextBlocks(sections, "client-state").slice(0, OCR_EVIDENCE_LIMIT),
    reviews,
    images: scopedImages.length > 0 ? scopedImages : unique(productRecords.flatMap((record) => readClientStateImages(record, source))),
    options: (scopedOptions.length > 0 ? scopedOptions : unique(productRecords.flatMap(readClientStateOptions)).filter(isProductOptionText)).slice(0, 12),
    name: firstStringFromRecords(scopedProductRecords, ["onlineProdName", "productName", "prodName", "name", "title"], isLikelyProductName),
    brand: firstBrandFromRecords(scopedProductRecords) ?? firstBrandFromRecords(productRecords),
    description: firstStringFromRecords(scopedProductRecords, ["linePromoDesc", "description", "desc", "summary", "shortDescription"], (text) =>
      text.length >= 20 && hasProductCareSignal(text) && !isReviewEvidenceText(text)
    ),
    price: firstClientStatePrice(scopedProductRecords) ?? firstClientStatePrice(productRecords),
    currency: firstClientStateCurrency(scopedProductRecords) ?? firstClientStateCurrency(productRecords)
  };
}

function productRecordsForSource(records: Array<Record<string, unknown>>, source: string): Array<Record<string, unknown>> {
  const handle = productHandleFromSource(source);
  if (!handle) {
    return records;
  }

  const matched = records.filter((record) => productStateRecordMatchesHandle(record, handle));
  return matched.length > 0 ? matched : records;
}

function readClientStateJson($: ReturnType<typeof load>): unknown[] {
  const parsed: unknown[] = [];

  $("script#__NEXT_DATA__, script[type='application/json']").each((_, node) => {
    const json = parseJsonText($(node).text());
    if (json !== undefined) {
      parsed.push(...expandEmbeddedJsonState(json));
    }
  });

  $("script:not([type]), script[type='text/javascript'], script[type='application/javascript']").each((_, node) => {
    const scriptText = $(node).html() ?? $(node).text();
    parsed.push(...extractAssignedJsonStates(scriptText));
  });

  return uniqueStateObjects(parsed).slice(0, 24);
}

function expandEmbeddedJsonState(value: unknown, depth = 0, seen = new Set<unknown>()): unknown[] {
  if (depth > 5) {
    return [];
  }

  const states: unknown[] = [value];

  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    return parsed === undefined ? states : [...states, ...expandEmbeddedJsonState(parsed, depth + 1, seen)];
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    return states;
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (typeof child === "string") {
      const parsed = parseJsonText(child);
      if (parsed !== undefined) {
        states.push(...expandEmbeddedJsonState(parsed, depth + 1, seen));
      }
      continue;
    }

    if (isRecord(child) || Array.isArray(child)) {
      states.push(...expandEmbeddedJsonState(child, depth + 1, seen));
    }
  }

  return states;
}

function extractAssignedJsonStates(scriptText: string): unknown[] {
  if (!/(?:__INITIAL_STATE__|__PRELOADED_STATE__|__PRODUCT__|initialState|productDetail|productInfo|productData|productState|reviewInfo|reviews?)/i.test(scriptText)) {
    return [];
  }

  const states: unknown[] = [];
  const assignmentPatterns = [
    /(?:window\.)?__INITIAL_STATE__\s*=\s*\{/g,
    /(?:window\.)?__PRELOADED_STATE__\s*=\s*\{/g,
    /(?:window\.)?__PRODUCT__\s*=\s*\{/g,
    /(?:window\.)?initialState\s*=\s*\{/gi,
    /(?:window\.)?product(?:Detail|Info|Data|State)?\s*=\s*\{/gi
  ];

  for (const pattern of assignmentPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(scriptText)) !== null) {
      const objectStart = scriptText.indexOf("{", match.index);
      const literal = readBalancedObjectLiteral(scriptText, objectStart);
      const parsed = literal ? parseEmbeddedObjectLiteral(literal) : undefined;
      if (parsed !== undefined) {
        states.push(...expandEmbeddedJsonState(parsed));
      }
    }
  }

  return states;
}

function parseEmbeddedObjectLiteral(literal: string): unknown | undefined {
  const parsed = parseJsonText(literal);
  if (parsed !== undefined) {
    return parsed;
  }

  const jsonLike = literal
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  return parseJsonText(jsonLike);
}

function uniqueStateObjects(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const value of values) {
    const fingerprint = typeof value === "object" && value !== null
      ? Object.keys(value as Record<string, unknown>).slice(0, 12).join("|")
      : String(value).slice(0, 120);

    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    result.push(value);
  }

  return result;
}

function contentSectionsToPageTextBlocks(sections: ProductContentSection[], prefix: string): PageTextBlock[] {
  const blocks: PageTextBlock[] = [];

  for (const [sectionIndex, section] of sections.entries()) {
    const chunks = chunkText(section.text, section.category === "ingredient" ? 1100 : 920);

    for (const [chunkIndex, chunk] of chunks.entries()) {
      blocks.push({
        id: `${prefix}-${sectionIndex + 1}-${chunkIndex + 1}`,
        title: section.title,
        text: chunk
      });
    }
  }

  return mergePageTextBlocks(blocks);
}

function collectProductStateRecords(value: unknown, depth = 0, seen = new Set<unknown>()): Array<Record<string, unknown>> {
  if (depth > 7 || !isRecord(value) && !Array.isArray(value)) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const records: Array<Record<string, unknown>> = [];

  if (isRecord(value)) {
    if (isLikelyProductStateRecord(value)) {
      records.push(value);
    }

    for (const [key, child] of Object.entries(value)) {
      if (!shouldTraverseClientStateKey(key)) {
        continue;
      }
      records.push(...collectProductStateRecords(child, depth + 1, seen));
    }

    return records;
  }

  for (const child of value) {
    records.push(...collectProductStateRecords(child, depth + 1, seen));
  }

  return records;
}

function isLikelyProductStateRecord(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).map(normalizeObjectKey).join(" ");
  const hasProductNoun = /(product|prod|goods|item|sku|상품|제품|online prod)/i.test(keys);
  const hasProductData = /(online prod name|product name|prod name|line promo desc|price info|online images|images|ingredients|disclosures|detail desc|review info)/i.test(keys);
  return hasProductData || hasProductNoun && /(name|title|price|image|review|ingredient|description|desc|summary)/i.test(keys);
}

function shouldTraverseClientStateKey(key: string): boolean {
  return !/^(auth|account|cart|order|coupon|favorite|delivery|ship|seller|payment|popup|dialog|loading|form|header|footer|navigation|menu|category|event|banner|recommend|recent|cache)$/i.test(key);
}

function productStateRecordMatchesHandle(record: Record<string, unknown>, handle: string): boolean {
  const normalizedHandle = normalizeFingerprint(safeDecodeURIComponent(handle));
  const directHandle = firstStringValue(record, [
    "handle",
    "productHandle",
    "prodHandle",
    "onlineProdHandle",
    "slug"
  ]);

  if (directHandle && normalizeFingerprint(safeDecodeURIComponent(directHandle)) === normalizedHandle) {
    return true;
  }

  const productUrl = firstStringValue(record, [
    "url",
    "href",
    "productUrl",
    "product_url",
    "link",
    "canonicalUrl",
    "canonical_url"
  ]);
  if (productUrl) {
    const urlHandle = productHandleFromSource(productUrl);
    if (urlHandle && normalizeFingerprint(safeDecodeURIComponent(urlHandle)) === normalizedHandle) {
      return true;
    }
    if (normalizeFingerprint(productUrl).includes(normalizedHandle)) {
      return true;
    }
  }

  const name = firstStringFromRecords([record], ["onlineProdName", "productName", "prodName", "name", "title"], isLikelyProductName);
  return name ? scoreProductNameAgainstHandle(name, handle) >= 120 : false;
}

function readClientStateImages(record: Record<string, unknown>, source: string): string[] {
  return unique([
    ...readImageUrls(record.image, source),
    ...readImageUrls(record.images, source),
    ...readImageUrls(record.onlineImages, source),
    ...readImageUrls(record.media, source),
    absoluteUrl(stringValue(record.imgUrl), source),
    absoluteUrl(stringValue(record.imageUrl), source),
    absoluteUrl(stringValue(record.thumbnailUrl), source),
    ...extractHtmlImageUrls(stringValue(record.detailDesc) ?? stringValue(record.bodyHtml) ?? stringValue(record.body_html) ?? "", source)
  ].filter(Boolean));
}

function extractHtmlImageUrls(html: string, source: string): string[] {
  const fragment = /<(?:img|source|picture)[\s>]/i.test(html) ? load(html) : undefined;
  const domImageUrls = fragment
    ? fragment("img, picture source").toArray().flatMap((node) => imageUrlsFromNode(fragment, node, source))
    : [];
  return unique([
    ...domImageUrls,
    ...extractRawImageUrls(html, source)
  ].filter(Boolean));
}

function readClientStateOptions(record: Record<string, unknown>): string[] {
  return unique([
    stringValue(record.optionName),
    stringValue(record.optionValue),
    ...arrayRecords(record.products).flatMap((product) => [
      stringValue(product.prodName),
      stringValue(product.productName),
      stringValue(product.name)
    ]),
    ...arrayRecords(record.variants).flatMap((variant) => [
      stringValue(variant.title),
      stringValue(variant.name),
      stringValue(variant.optionName)
    ])
  ].filter(Boolean));
}

function firstStringFromRecords(
  records: Array<Record<string, unknown>>,
  keys: string[],
  predicate?: (text: string) => boolean
): string | undefined {
  for (const record of records) {
    const value = firstKnownValue(record, keys);
    const text = typeof value === "string" && /<[^>]+>/.test(value)
      ? htmlToText(value) ?? cleanText(value)
      : stringValue(value);

    if (text && (!predicate || predicate(text))) {
      return text;
    }
  }

  return undefined;
}

function firstBrandFromRecords(records: Array<Record<string, unknown>>): string | undefined {
  for (const record of records) {
    const candidate = firstDefined([
      productBrandFromValue(firstKnownValue(record, ["brand", "brandName", "brandNm", "brndName", "brndNm"])),
      productBrandFromValue(firstKnownValue(record, ["manufacturer", "manufacturerName", "maker", "vendor"]))
    ]);
    if (candidate && isLikelyBrandName(candidate, firstStringFromRecords([record], ["onlineProdName", "productName", "prodName", "name", "title"]) ?? "")) {
      return cleanText(candidate);
    }
  }

  return undefined;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function isLikelyProductName(text: string): boolean {
  return text.length >= 2 && text.length <= 140 && !isNonProductCommerceText(text) && !isReviewEvidenceText(text);
}

function firstClientStatePrice(records: Array<Record<string, unknown>>): string | undefined {
  for (const record of records) {
    const direct = firstKnownValue(record, ["discountedPrice", "salePrice", "price", "amount", "beforeSalePrice"]);
    const nested = [
      firstObject(record.priceInfo),
      firstObject(firstObject(record.onlinePriceInfo)?.priceInfo),
      firstObject(firstObject(record.prodPriceInfo)?.priceInfo)
    ].flatMap((item) => item ? [
      item.discountedPrice,
      item.salePrice,
      item.price,
      item.amount,
      item.beforeSalePrice
    ] : []);
    const value = [direct, ...nested].map(stringValue).find(Boolean);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function firstClientStateCurrency(records: Array<Record<string, unknown>>): string | undefined {
  for (const record of records) {
    const direct = firstStringValue(record, ["priceCurrency", "currency", "currencyCode"]);
    if (direct) {
      return direct;
    }

    const currencyInfo = firstObject(record.currencyInfo)
      ?? firstObject(firstObject(record.onlinePriceInfo)?.currencyInfo)
      ?? firstObject(firstObject(record.prodPriceInfo)?.currencyInfo);
    if (currencyInfo?.isWon === true) {
      return "KRW";
    }
  }

  return undefined;
}

function extractClientStateReviews(value: unknown): ReviewSummary {
  const summaries: ReviewSummary[] = [];
  const seen = new Set<unknown>();

  function visit(current: unknown, path: string[], depth: number) {
    if (depth > 8 || !isRecord(current) && !Array.isArray(current)) {
      return;
    }
    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, path, depth + 1);
      }
      return;
    }

    const context = cleanText([...path, ...Object.keys(current)].join(" "));
    if (isReviewStateContext(context)) {
      const summary = reviewSummaryFromStateRecord(current);
      if (summary.rating || summary.reviewCount || summary.items.length > 0 || summary.keywords.length > 0) {
        summaries.push(summary);
      }
    }

    for (const [key, child] of Object.entries(current)) {
      if (shouldTraverseClientStateKey(key)) {
        visit(child, [...path, key], depth + 1);
      }
    }
  }

  visit(value, [], 0);
  return mergeReviewSummaries(...summaries);
}

function isReviewStateContext(text: string): boolean {
  return /(review|rating|scope|star|평점|별점|리뷰|후기|prodReview)/i.test(text);
}

function reviewSummaryFromStateRecord(record: Record<string, unknown>): ReviewSummary {
  const summaryTexts = unique([
    firstStringValue(record, ["longSummary", "shortSummary", "reviewSummaryMessage", "reviewSummaryText", "reviewSummarySubTitle", "summary", "aiSummary"]),
    ...["longSummary", "shortSummary", "reviewSummaryMessage", "reviewSummaryText", "reviewSummarySubTitle"].flatMap((key) => arrayValues(record[key]))
  ])
    .map((text) => htmlToText(text) ?? cleanText(text))
    .filter((text) => text.length >= 12 && isReviewEvidenceText(text));
  const explicitItem = reviewItemFromStateRecord(record);
  const summaryItems = summaryTexts.map((body): ReviewItem => ({
    body,
    rating: firstStateNumber(record, ["reviewScope", "reviewAverage", "scopeAvg", "rating", "ratingValue", "reviewScore", "scope"])
  }));
  const items = mergeReviewItems(
    explicitItem ? [explicitItem] : [],
    summaryItems
  ).slice(0, 12);

  return {
    rating: firstStateNumber(record, ["reviewScope", "reviewAverage", "scopeAvg", "rating", "ratingValue", "reviewScore"]),
    reviewCount: firstStateNumber(record, ["reviewCount", "reviewCnt", "totalCount", "totalCnt", "count"]),
    items,
    keywords: mergeKeywords(
      keywordsFromReviews(items),
      ...summaryTexts.map((text) => keywordsFromText(text, "review"))
    )
  };
}

function reviewItemFromStateRecord(record: Record<string, unknown>): ReviewItem | undefined {
  const bodyValue = firstKnownValue(record, [
    "prodReviewBodyText",
    "reviewBody",
    "reviewText",
    "body",
    "content",
    "comment",
    "text"
  ]);
  const body = typeof bodyValue === "string" && /<[^>]+>/.test(bodyValue)
    ? htmlToText(bodyValue) ?? cleanText(bodyValue)
    : stringValue(bodyValue);

  if (!body || body.length < 16 || !isReviewEvidenceText(body) || isReviewChromeText(body)) {
    return undefined;
  }

  const profile = firstObject(record.profile);
  return {
    body: body.slice(0, 1200),
    author: firstStringValue(record, ["memberId", "naverId", "nickname", "nickName", "customerNickname", "userName", "author"])
      ?? firstStringValue(profile ?? {}, ["nickName", "nickname", "name"]),
    rating: firstStateNumber(record, ["scope", "rating", "ratingValue", "reviewScope", "reviewAverage"]),
    datePublished: firstStringValue(record, ["prodReviewRegistDt", "datePublished", "createdAt", "createdDate", "registDt"])
  };
}

function firstStateNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(firstKnownValue(record, [key]));
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

function mergeReviewSummaries(...summaries: ReviewSummary[]): ReviewSummary {
  const rating = summaries.map((summary) => summary.rating).find((value): value is number => typeof value === "number");
  const reviewCount = summaries.map((summary) => summary.reviewCount).find((value): value is number => typeof value === "number");
  const items = mergeReviewItems(...summaries.map((summary) => summary.items)).slice(0, 12);
  const keywords = mergeKeywords(
    ...summaries.map((summary) => summary.keywords),
    keywordsFromReviews(items)
  ).slice(0, 28);

  return {
    rating,
    reviewCount,
    items,
    keywords
  };
}

function extractKeyedProductSections(value: unknown): ProductContentSection[] {
  const sections: ProductContentSection[] = [];
  const seenObjects = new Set<unknown>();

  function visit(current: unknown, depth: number) {
    if (depth > 5) {
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, depth + 1);
      }
      return;
    }

    if (!isRecord(current) || seenObjects.has(current)) {
      return;
    }

    seenObjects.add(current);

    const structuredSection = sectionFromStructuredRecord(current);
    if (structuredSection) {
      sections.push(structuredSection);
    }

    for (const [key, item] of Object.entries(current)) {
      const category = categoryFromObjectKey(key);
      if (category) {
        const text = textFromSectionValue(item);
        const title = normalizeObjectSectionTitle(key);
        const section = createContentSection(title, category, text);

        if (section && isKeyedProductSectionValue(title, text, category)) {
          sections.push(section);
        }
      }

      if (!shouldTraverseObjectKey(key)) {
        continue;
      }

      visit(item, depth + 1);
    }
  }

  visit(value, 0);
  return uniqueContentSections(sections).slice(0, 32);
}

function keyedSectionTexts(sections: ProductContentSection[], category: ProductContentCategory): string[] {
  return unique(sections.filter((section) => section.category === category).map((section) => section.text));
}

function createKeyedContentSections(sections: ProductContentSection[]): ProductContentSection[] {
  return uniqueContentSections(sections.filter((section) => section.category !== "unknown")).slice(0, 24);
}

function isKeyedProductSectionValue(title: string, text: string, category: ProductContentCategory): boolean {
  const value = cleanText(text);

  if (value.length === 0 || isNonProductCommerceText(`${title} ${value}`)) {
    return false;
  }

  if (category === "benefit" || category === "effect" || category === "ingredient" || category === "usage") {
    return isSemanticFieldValue(value, category) || isProductEvidenceCandidate(title, value) || value.length >= 24;
  }

  if (category === "metric") {
    return isSemanticFieldValue(value, "metric") || isProductMetricEvidenceText(value);
  }

  if (category === "review") {
    return isReviewEvidenceText(value);
  }

  if (category === "faq") {
    return isFaqEvidenceText(`${title} ${value}`) || (value.length >= 24 && /(\?|faq|q&a|question|answer|질문|답변)/i.test(`${title} ${value}`));
  }

  return isProductEvidenceCandidate(title, value);
}

function sectionFromStructuredRecord(record: Record<string, unknown>): ProductContentSection | undefined {
  const title = firstStringValue(record, [
    "title",
    "heading",
    "label",
    "name",
    "key",
    "itemName",
    "disclosureItemName",
    "questionHeader",
    "reviewSummaryTitle"
  ]);
  if (!title) {
    return undefined;
  }

  const category = categoryFromObjectKey(title);
  if (!category) {
    return undefined;
  }

  const text = textFromSectionValue(firstKnownValue(record, [
    "text",
    "body",
    "content",
    "html",
    "value",
    "description",
    "copy",
    "answer",
    "prodDisclosureInfo",
    "disclosureInfo",
    "responseBodyText",
    "prodReviewBodyText",
    "reviewBody",
    "reviewText",
    "tipDoc"
  ]));
  const section = createContentSection(title, category, text);
  return section && isKeyedProductSectionValue(title, text, category) ? section : undefined;
}

function categoryFromObjectKey(key: string): ProductContentCategory | undefined {
  const normalized = normalizeObjectKey(key);

  if (/(^| )(ingredients?|key ingredients?|ingredient highlights?|full ingredients?|formula|formulated without|전성분|주요 성분|성분|원료)( |$)/i.test(normalized)) {
    return "ingredient";
  }
  if (/(^| )(how to use|directions?|usage|application|ritual|routine|사용법|사용 ?방법|사용방법|도포)( |$)/i.test(normalized)) {
    return "usage";
  }
  if (/(^| )(benefits?|product benefits?|why you'?ll love it|good for|solution for|works best for|skin concern|장점|효능|피부 고민)( |$)/i.test(normalized)) {
    return "benefit";
  }
  if (/(^| )(clinical results?|results?|effects?|efficacy|claims?|before after|효과|결과|개선)( |$)/i.test(normalized)) {
    return "effect";
  }
  if (/(^| )(faqs?|questions?|q ?a|q&a|자주 묻는 질문|질문|답변)( |$)/i.test(normalized)) {
    return "faq";
  }
  if (/(^| )(ratings?|review signals?|review summary|reviews?|평점|리뷰|후기)( |$)/i.test(normalized)) {
    return "review";
  }
  if (/(^| )(metrics?|statistics?|survey|수치|지표)( |$)/i.test(normalized)) {
    return "metric";
  }

  return undefined;
}

function normalizeObjectKey(key: string): string {
  return cleanText(key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\/\s*/g, " ")
    .toLowerCase());
}

function normalizeObjectSectionTitle(key: string): string {
  const normalized = normalizeObjectKey(key);
  return normalized.length > 0
    ? normalized.replace(/\b\w/g, (character) => character.toUpperCase())
    : key;
}

function textFromSectionValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return htmlToText(String(value)) ?? cleanText(String(value));
  }

  if (Array.isArray(value)) {
    return cleanText(value.map(textFromSectionValue).filter(Boolean).join("\n"));
  }

  if (!isRecord(value)) {
    return "";
  }

  const directText = firstKnownValue(value, [
    "text",
    "body",
    "content",
    "html",
    "value",
    "description",
    "copy",
    "answer",
    "prodDisclosureInfo",
    "disclosureInfo",
    "responseBodyText",
    "prodReviewBodyText",
    "reviewBody",
    "reviewText"
  ]);
  if (directText !== undefined) {
    return textFromSectionValue(directText);
  }

  return cleanText(Object.entries(value)
    .filter(([key]) => shouldUseNestedTextKey(key))
    .map(([, item]) => textFromSectionValue(item))
    .filter(Boolean)
    .join("\n"));
}

function firstKnownValue(record: Record<string, unknown>, keys: string[]): unknown | undefined {
  for (const key of keys) {
    const exact = record[key];
    if (exact !== undefined) {
      return exact;
    }

    const matchedKey = Object.keys(record).find((candidate) => normalizeObjectKey(candidate) === normalizeObjectKey(key));
    if (matchedKey) {
      return record[matchedKey];
    }
  }

  return undefined;
}

function firstStringValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = firstKnownValue(record, keys);
  return stringValue(value);
}

function shouldTraverseObjectKey(key: string): boolean {
  return !/^(id|sku|handle|url|href|src|image|images|media|variants?|offers?|price|compare_at_price|selling_plan|selling_plans|selling_plan_groups|options?|tags?|collections?|inventory|barcode|vendor|type|created_at|published_at|updated_at|available|requires_shipping|taxable)$/i.test(key);
}

function shouldUseNestedTextKey(key: string): boolean {
  return !/^(id|sku|handle|url|href|src|image|images|media|price|amount|currency|barcode|vendor|type|created_at|published_at|updated_at|available)$/i.test(key);
}

function sectionHeading($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  const tagName = element.prop("tagName")?.toLowerCase();

  if (tagName && /^(h1|h2|h3|h4|summary|button)$/.test(tagName)) {
    return cleanText(element.text());
  }

  return cleanText(element.find("h1,h2,h3,h4,summary,button,[role='heading']").first().text());
}

function sectionText($: ReturnType<typeof load>, node: CheerioInput, heading: string): string {
  const element = $(node);
  const controlledText = controlledSectionText($, element.attr("aria-controls"));
  const siblingText = siblingSectionText($, node);
  const ownText = cleanText(element.text());
  const text = cleanText([heading, controlledText || siblingText || ownText].filter(Boolean).join(" "));
  const headingOnly = cleanText(heading);

  return text === headingOnly ? "" : text;
}

function controlledSectionText($: ReturnType<typeof load>, controls: string | undefined): string {
  if (!controls) {
    return "";
  }

  const texts = controls.split(/\s+/).flatMap((id) =>
    $("[id]").toArray()
      .filter((node) => $(node).attr("id") === id)
      .map((node) => cleanText($(node).text()))
  );

  return cleanText(texts.join(" "));
}

function siblingSectionText($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  const tagName = element.prop("tagName")?.toLowerCase();

  if (tagName === "summary") {
    return cleanText(element.closest("details").text());
  }

  if (!tagName || !/^(h2|h3|h4|button)$/.test(tagName)) {
    return "";
  }

  const texts: string[] = [];
  let sibling = element.next();
  let count = 0;

  while (sibling.length > 0 && count < 10) {
    const siblingTag = sibling.prop("tagName")?.toLowerCase();
    const siblingText = cleanText(sibling.text());

    if (siblingTag && /^(h1|h2|h3|h4)$/.test(siblingTag)) {
      break;
    }

    if ((siblingTag === "button" || sibling.attr("role") === "button") && isSectionHeadingText(siblingText)) {
      break;
    }

    texts.push(siblingText);
    sibling = sibling.next();
    count += 1;
  }

  return cleanText(texts.join(" "));
}

function isLikelyObstructiveText(text: string): boolean {
  return /(close|sign in|create an account|forgot your password|your cart|checkout|newsletter|email|subscribe|offers|notify me|back in stock|cookie|privacy policy|terms)/i.test(text);
}

function isLikelyObstructiveNode(tokenText: string, text: string): boolean {
  const tokensMatch = /(^|[-_\s])(modal|popup|overlay|backdrop|newsletter|klaviyo|cookie|drawer|cart|account|search)([-_\s]|$)/i.test(tokenText);
  return tokensMatch && (text.length < 40 || isLikelyObstructiveText(text));
}

function nodeAttributeText($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  return [
    element.attr("id"),
    element.attr("class"),
    element.attr("role"),
    element.attr("aria-label"),
    element.attr("data-testid"),
    element.attr("data-section-type")
  ].filter(Boolean).join(" ");
}

function scoreProductText(text: string, productName: string): number {
  const lowerText = text.toLowerCase();
  const productTerms = productName.toLowerCase().split(/\W+/).filter((term) => term.length >= 4);
  const productScore = productTerms.filter((term) => lowerText.includes(term)).length * 3;
  const signalScore = [
    /benefit|ingredient|how to use|how-to-use|directions|ritual|faq|result|clinical|review|summary|formulated without|key ingredients/i,
    /skin|serum|cream|ginseng|retinol|niacinamide|peptide|wrinkle|firm|elastic|moistur|texture|radiance|anti-aging|apply|water|aqua|glycol|extract/i,
    /피부|보습|수분|진정|탄력|장벽|주름|효능|효과|성분|사용|리뷰|자생력|고밀도|영양|인삼|펩타이드|스킨케어/i
  ].filter((pattern) => pattern.test(text)).length * 4;
  const lengthScore = Math.min(Math.floor(text.length / 120), 6);
  const commercePenalty = isNonProductCommerceText(text) ? 12 : 0;

  return productScore + signalScore + lengthScore - commercePenalty;
}

function isProductEvidenceCandidate(title: string, text: string): boolean {
  const value = cleanText(`${title} ${text}`);

  if (value.length === 0 || isNonProductCommerceText(value)) {
    return false;
  }

  return hasProductCareSignal(value)
    // 줄 구조가 살아 있는 원문을 넘긴다. 공백으로 눌린 텍스트에서는 절 제목이
    // 한 줄로 뭉쳐 보이지 않는다.
    || declaresProductSectionRole(`${title}\n${text}`)
    || isReviewEvidenceText(value)
    || isFaqEvidenceText(value)
    || isProductMetricEvidenceText(value);
}

/**
 * 원문이 절 제목으로 역할을 선언했는지.
 *
 * 관리 어휘(피부·보습·skin·hydration…)를 요구하는 판정은 한국어 사용법에는
 * 대개 그런 낱말이 섞여 있어 통했지만, 영문 사용법 지시문에는 하나도 없다 —
 * "Dispense an appropriate amount onto wet hands and lather." 그래서 미국 대상
 * 페이지의 사용법 이미지가 통째로 공개 출력에서 빠졌다.
 *
 * 제목이 "이것은 사용법이다"라고 이미 말했다면 그것이 제품 근거라는 증거다.
 * 어휘를 언어별로 늘리는 대신, 제목→역할을 읽는 단일 출처를 그대로 쓴다.
 */
function declaresProductSectionRole(value: string): boolean {
  return parseOcrBlockSections(value)
    .some((section) => section.heading !== undefined && sectionHeadingCategory(section.heading) !== undefined);
}

function isNonProductCommerceText(text: string): boolean {
  const value = cleanText(text);
  const hardCommercePattern = /(레이어\s*(?:열기|닫기)|장바구니|구매하기|바로구매|제품 수량|상품 수량|수량 감소|수량 증가|총 상품가|혜택 적용가|네이버페이|뷰티포인트|적립 제외|사용 제외|재입고|알림 신청|레이어 닫기|판매자 정보|상품정보제공 고시|배송\/교환\/반품|배송지역|배송기간|배송비|교환\/반품|반품\/교환|청약철회|고객센터|택배기사|회수 상품|반송 주소|구매안전서비스|에스크로|KG이니시스|무료배송|첫 구매 혜택|혜택보기|cart|checkout|shipping|returns?|refund|subscribe|newsletter)/i;
  const policyPattern = /(배송|교환|반품|환불|주문취소|청약철회|고객변심|택배|반송|회수|미성년자|법정대리인|이용약관|도서지역|사서함|배송비|판매자|고시)/i;

  if (hardCommercePattern.test(value)) {
    return true;
  }

  return value.length > 120 && policyPattern.test(value) && !hasStrongProductCareSignal(value);
}

function hasProductCareSignal(text: string): boolean {
  return /(피부|보습|수분|탄력|장벽|광채|영양|진정|주름|잔주름|피부결|고밀도|자생력|인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민|성분|효능|효과|사용법|도포|세럼|크림|에센스|앰플|토너|로션|serum|cream|essence|ampoule|skin|hydration|moisture|firming|firmness|firmer|elastic|radiance|resilience|plumpness|wrinkle|ingredient|retinol|niacinamide|peptide|hyaluronic|apply)/i.test(text);
}

function hasStrongProductCareSignal(text: string): boolean {
  const matches = text.match(/피부|보습|수분|탄력|장벽|광채|주름|피부결|인삼|레티놀|나이아신아마이드|펩타이드|효능|효과|사용법|도포|hydration|firming|wrinkle|ingredient|retinol|niacinamide|apply/gi) ?? [];
  return matches.length >= 2;
}

function isReviewEvidenceText(text: string): boolean {
  return /(리뷰|후기|평점|별점|재구매|만족|흡수|촉촉|review|rating|stars?|repurchase|satisfied|smooth|customer)/i.test(text) && !isNonProductCommerceText(text);
}

function isFaqEvidenceText(text: string): boolean {
  return /(\?|FAQ|Q&A|자주|질문|답변)/i.test(text) && hasProductCareSignal(text);
}

function isProductMetricEvidenceText(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:weeks?|days?|hours?|drops?|pumps?|times?)\b|주|일|시간|회/g.test(text) && hasProductCareSignal(text);
}

function createProductSectionBuckets(pageTextBlocks: PageTextBlock[]): ProductSectionBuckets {
  const buckets: ProductSectionBuckets = {
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    sections: []
  };

  for (const block of pageTextBlocks) {
    const text = stripSectionTitle(block.title, block.text);
    if (!isProductEvidenceCandidate(block.title, text)) {
      continue;
    }

    const category = sectionCategory(block.title, text, keywordsFromTextAcrossCategories(text, "dom"));
    const values = sectionValues(text, category);
    const section = createContentSection(block.title, category, text);

    if (section) {
      buckets.sections.push(section);
    }

    if (category === "benefit") {
      buckets.benefits.push(...values);
    }
    if (category === "effect") {
      buckets.effects.push(...values);
    }
    if (category === "ingredient") {
      buckets.ingredients.push(...values);
    }
    if (category === "usage") {
      buckets.usage.push(...values);
    }

    buckets.metrics.push(...extractMetricPhrases(text));
  }

  return {
    benefits: unique(buckets.benefits).slice(0, 12),
    effects: unique(buckets.effects).slice(0, 12),
    ingredients: unique(buckets.ingredients).slice(0, 12),
    usage: unique(buckets.usage).slice(0, 12),
    metrics: unique(buckets.metrics).slice(0, 16),
    sections: uniqueContentSections(buckets.sections).slice(0, 24)
  };
}

function sectionCategory(title: string, text: string, keywords: ClassifiedKeyword[]): ProductContentCategory {
  const label = cleanText(title).toLowerCase();
  const joined = `${label} ${text.slice(0, 220).toLowerCase()}`;

  if (isNonProductCommerceText(joined) || isNonProductCommerceText(text)) {
    return "unknown";
  }
  if (isFullIngredientList(text)) {
    return "ingredient";
  }
  if (/^(ingredients?|key ingredients?|formula|formulated without|성분|주요 성분|전성분|원료)$/i.test(label)) {
    return "ingredient";
  }
  if (/^(how to use|how-to-use|directions|application|ritual|routine|사용법|사용 ?방법|사용방법|사용|도포)$/i.test(label)) {
    return "usage";
  }
  if (/^(benefits?|why you'?ll love it|good for|장점|효능|피부\s?고민)$/i.test(label)) {
    return "benefit";
  }
  if (/^(clinical results?|results?|efficacy|효과|결과|개선)$/i.test(label)) {
    return "effect";
  }
  if (/(review|customer|rating|stars?|리뷰|후기|평점|별점)/i.test(joined)) {
    return /(rating|stars?|평점|별점)/i.test(joined) ? "rating" : "review";
  }
  if (/(faq|question|answer|q&a|자주|질문|답변)/i.test(joined)) {
    return "faq";
  }
  if (/(ingredient|formula|formulated without|성분|원료|전성분)/i.test(joined)) {
    return "ingredient";
  }
  if (isMeasurementTimelineSentence(text)) {
    return "effect";
  }
  if (/(how to use|how-to-use|directions|application|ritual|routine|사용법|사용 ?방법|사용방법|사용|도포)/i.test(joined)) {
    return "usage";
  }
  if (/(benefit|why you|good for|helps|장점|효능|피부\s?고민|보습|수분|탄력|장벽|광채|자생력|고밀도)/i.test(joined)) {
    return "benefit";
  }
  if (/(clinical|result|efficacy|improvement|improved|diminish|diminished|firmer|elastic|wrinkles?|fine lines|효과|결과|개선)/i.test(joined)) {
    return "effect";
  }

  const ranked = new Map<ClassifiedKeyword["category"], number>();
  for (const keyword of keywords) {
    ranked.set(keyword.category, (ranked.get(keyword.category) ?? 0) + keyword.confidence);
  }

  const dominant = [...ranked.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return dominant === "benefit" || dominant === "effect" || dominant === "ingredient" || dominant === "usage" || dominant === "faq" || dominant === "review" || dominant === "metric"
    ? dominant
    : "unknown";
}

function sectionValues(text: string, category: ProductContentCategory): string[] {
  if (category === "unknown") {
    return [];
  }

  const maxLength = category === "ingredient"
    ? isFullIngredientList(text) ? 3000 : 1100
    : 420;
  return chunkText(text, maxLength)
    .map((chunk) => cleanText(chunk))
    .filter((chunk) => chunk.length >= 12)
    .slice(0, category === "ingredient" ? 4 : 3);
}

function createContentSection(title: string, category: ProductContentCategory, text: string): ProductContentSection | undefined {
  const normalizedText = cleanText(text);

  if (category === "unknown" || normalizedText.length < 12) {
    return undefined;
  }

  return {
    title: cleanText(title) || category,
    category,
    text: normalizedText.slice(0, category === "ingredient" ? 3600 : 1600),
    bullets: summarizeContentBullets(normalizedText)
  };
}

function summarizeContentBullets(text: string): string[] {
  const normalized = cleanText(text);
  const listParts = normalized.split(/\s*(?:[•·]| - |\|)\s*/).filter((item) => item.length >= 12);
  const sentenceParts = normalized.split(/(?<=[.!?。！？])\s+/).filter((item) => item.length >= 12);
  const parts = listParts.length > 1 ? listParts : sentenceParts;
  return unique(parts.map((item) => cleanText(item).slice(0, 220))).slice(0, 6);
}

function createApiContentSections(candidates: OcrTextCandidate[], keywords: ClassifiedKeyword[]): ProductContentSection[] {
  return uniqueContentSections(candidates.flatMap((candidate, index) => {
    const category = sectionCategory(`API content ${index + 1}`, candidate.text, keywords);
    const section = createContentSection(`API content ${index + 1}`, category, candidate.text);
    return section ? [section] : [];
  })).slice(0, 16);
}

function uniqueContentSections(sections: ProductContentSection[]): ProductContentSection[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    const fingerprint = `${section.category}:${normalizeFingerprint(section.text)}`;
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
}

function ratingSummarySection(reviews: ReviewSummary): ProductContentSection[] {
  const summary = createRatingSummary(reviews);

  if (!summary) {
    return [];
  }

  return [{
    title: "Customer rating",
    category: "rating",
    text: summary,
    bullets: [summary]
  }];
}

function createRatingSummary(reviews: ReviewSummary): string | undefined {
  if (typeof reviews.rating !== "number" && typeof reviews.reviewCount !== "number") {
    return undefined;
  }

  return [
    typeof reviews.rating === "number" ? `Rating ${reviews.rating}` : undefined,
    typeof reviews.reviewCount === "number" ? `${reviews.reviewCount} reviews` : undefined
  ].filter(Boolean).join(" · ");
}

function stripSectionTitle(title: string, text: string): string {
  const normalizedTitle = cleanText(title);
  let normalizedText = cleanText(text);

  while (normalizedTitle.length > 0 && normalizedText.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
    normalizedText = cleanText(normalizedText.slice(normalizedTitle.length));
  }

  return normalizedText;
}

function stripSourceSectionLabel(text: string): string {
  return cleanText(text.replace(/^\[[^\]]+\]\s*/, ""));
}

function normalizeFingerprint(text: string): string {
  return cleanText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").slice(0, 260);
}

function isSectionHeadingText(text: string): boolean {
  return /^(benefits?|ingredients?|key ingredients?|formula|how to use|directions|clinical results?|results?|faq|reviews?|성분|주요 성분|전성분|원료|효능|효과|사용법|사용 ?방법|사용방법|리뷰|후기)$/i.test(cleanText(text));
}

function countSectionHeadingOccurrences(text: string): number {
  return (cleanText(text).match(/\b(?:benefits?|ingredients?|key ingredients?|formula|how to use|directions|clinical results?|results?|faq|reviews?)\b|주요 성분|전성분|성분|원료|효능|효과|사용 ?방법|사용방법|사용법|리뷰|후기/gi) ?? []).length;
}

function chunkText(text: string, maxLength: number): string[] {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).map(cleanText).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences.length > 0 ? sentences : [text]) {
    if ((current + " " + sentence).trim().length > maxLength && current.length > 0) {
      chunks.push(current);
      current = sentence;
      continue;
    }
    current = [current, sentence].filter(Boolean).join(" ");
  }

  if (current.length > 0) {
    chunks.push(current.slice(0, maxLength));
  }

  return chunks;
}

const defaultPageFetchHeaders = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
};

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const response = await fetch(url, { headers: htmlFetchHeaders(headers) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}${await responseErrorSuffix(response)}`);
  }
  return response.text();
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers: { ...defaultPageFetchHeaders, Accept: "application/json", ...headers } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}${await responseErrorSuffix(response)}`);
  }
  return response.json();
}

function htmlFetchHeaders(headers?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...defaultPageFetchHeaders, ...headers };
  const acceptKey = Object.keys(merged).find((key) => key.toLowerCase() === "accept");

  if (acceptKey && !/(text\/html|application\/xhtml\+xml|\*\/\*)/i.test(merged[acceptKey] ?? "")) {
    merged[acceptKey] = defaultPageFetchHeaders.Accept;
  }

  return merged;
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = cleanText(await response.text().catch(() => ""));

  if (text.length === 0) {
    return "";
  }

  return ` - ${text.slice(0, 180)}`;
}

function readJsonLdNodes($: ReturnType<typeof load>): Array<Record<string, unknown>> {
  return $("script[type='application/ld+json']")
    .toArray()
    .flatMap((node) => {
      try {
        const parsed = JSON.parse($(node).text()) as unknown;
        return flattenJsonLd(parsed);
      } catch {
        return [];
      }
    });
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd);
  }
  if (!isRecord(value)) {
    return [];
  }
  const graph = Array.isArray(value["@graph"]) ? value["@graph"].flatMap(flattenJsonLd) : [];
  return [value, ...graph];
}

function findJsonLdNode(nodes: Array<Record<string, unknown>>, type: string): Record<string, unknown> | undefined {
  return nodes.find((node) =>
    [
      ...arrayValues(node["@type"]),
      ...arrayValues(node.type)
    ].some((item) => item.toLowerCase() === type.toLowerCase())
  );
}

function extractFaq($: ReturnType<typeof load>, faqNode?: Record<string, unknown>): FaqItem[] {
  const jsonLdFaq = readFaqArray(faqNode?.mainEntity);
  const domFaq = extractDomFaq($);

  return mergeFaqItems(jsonLdFaq, domFaq).slice(0, 12);
}

function extractDomFaq($: ReturnType<typeof load>): FaqItem[] {
  const detailsFaq = $("details")
    .toArray()
    .map((node) => ({
      question: cleanText($(node).find("summary").first().text()),
      answer: cleanText($(node).text().replace($(node).find("summary").first().text(), ""))
    }))
    .filter((item) => isFaqItem(item));
  const accordionFaq = $("button[aria-controls], [role='button'][aria-controls]")
    .toArray()
    .map((node) => {
      const element = $(node);
      const question = cleanText(element.find(".accordion__title,[class*='title']").first().text()) || cleanText(element.text());
      const answer = controlledSectionText($, element.attr("aria-controls"));
      return { question, answer };
    })
    .filter((item) => isFaqItem(item));

  return mergeFaqItems(detailsFaq, accordionFaq);
}

function isFaqItem(item: FaqItem): boolean {
  return item.question.length > 0
    && item.answer.length > 0
    && isFaqQuestionText(item.question)
    && !isNonProductCommerceText(`${item.question} ${item.answer}`);
}

function isFaqQuestionText(text: string): boolean {
  return /(\?|^(how|what|when|where|why|can|should|is|are|does|do|which)\b|자주|질문|답변)/i.test(cleanText(text));
}

function mergeFaqItems(...groups: FaqItem[][]): FaqItem[] {
  const seen = new Set<string>();
  const items: FaqItem[] = [];

  for (const item of groups.flat()) {
    const fingerprint = normalizeFingerprint(`${item.question}:${item.answer}`);

    if (fingerprint.length === 0 || seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    items.push(item);
  }

  return items;
}

function usageFromFaq(faq: FaqItem[]): string[] {
  return unique(faq
    .filter((item) => /(how|should|apply|use|usage|routine|사용|바르|도포)/i.test(`${item.question} ${item.answer}`))
    .map((item) => cleanText(item.answer))
    .filter((answer) => isSemanticFieldValue(answer, "usage")))
    .slice(0, 4);
}

const REVIEW_NODE_SELECTORS = [
  "[itemprop='review']",
  "[typeof*='Review']",
  "[data-review]",
  "[data-testid*='review']",
  "[class*='review']",
  "[id*='review']"
].join(",");

const GENERIC_REVIEW_META_KEYWORDS = new Set([
  "review",
  "reviews",
  "rating",
  "ratings",
  "customer",
  "customers",
  "star",
  "stars"
]);

type ReviewAggregateSource = Extract<ExtractionEvidence["source"], "jsonLd" | "dom" | "api">;

/**
 * Page review summary plus per-field provenance. Rating and review count fall
 * back independently, so a single shared label would attribute a DOM-scraped
 * count to JSON-LD whenever only one of the two is present in the markup.
 */
interface PageReviewExtraction {
  summary: ReviewSummary;
  ratingSource?: ReviewAggregateSource;
  reviewCountSource?: ReviewAggregateSource;
}

function extractReviews($: ReturnType<typeof load>, productNode: Record<string, unknown> | undefined): PageReviewExtraction {
  const aggregate = firstObject(productNode?.aggregateRating);
  const jsonLdReviews = readReviewArray(productNode?.review);
  const domReviews = extractDomReviews($);
  const items = mergeReviewItems(jsonLdReviews, domReviews).slice(0, 12);
  const jsonLdRating = numberValue(aggregate?.ratingValue);
  const jsonLdReviewCount = numberValue(aggregate?.reviewCount);
  const rating = jsonLdRating ?? extractDomRating($);
  const reviewCount = jsonLdReviewCount ?? extractDomReviewCount($);
  // The keyword fallback stays inside the review region. Scanning the whole
  // page turns product copy and infographic captions into fake customer
  // language, which downstream agents then publish as review evidence.
  const fallbackKeywords = items.length === 0
    ? keywordsFromText(extractReviewRegionText($), "review")
    : [];
  return {
    summary: {
      rating,
      reviewCount,
      items,
      keywords: customerReviewKeywords(mergeKeywords(keywordsFromReviews(items), fallbackKeywords))
    },
    ratingSource: aggregateFieldSource(jsonLdRating, rating),
    reviewCountSource: aggregateFieldSource(jsonLdReviewCount, reviewCount)
  };
}

/** Resolves one aggregate field's provenance: JSON-LD when it supplied the value, DOM when the fallback did. */
function aggregateFieldSource(jsonLdValue: number | undefined, resolvedValue: number | undefined): ReviewAggregateSource | undefined {
  if (typeof jsonLdValue === "number") {
    return "jsonLd";
  }

  return typeof resolvedValue === "number" ? "dom" : undefined;
}

/** Records each aggregate review field against the source that actually produced it. */
function pushReviewAggregateEvidence(
  evidence: ExtractionEvidence[],
  reviews: ReviewSummary,
  ratingSource: ReviewAggregateSource | undefined,
  reviewCountSource: ReviewAggregateSource | undefined
): void {
  if (typeof reviews.rating === "number" && ratingSource) {
    evidence.push({ field: "product.reviews.rating", source: ratingSource, value: String(reviews.rating) });
  }
  if (typeof reviews.reviewCount === "number" && reviewCountSource) {
    evidence.push({ field: "product.reviews.reviewCount", source: reviewCountSource, value: String(reviews.reviewCount) });
  }
}

/** Readable text of the page's review region, used only for review keyword fallback. */
function extractReviewRegionText($: ReturnType<typeof load>): string {
  const texts: string[] = [];

  for (const node of $(REVIEW_NODE_SELECTORS).toArray()) {
    const element = $(node);
    if (element.find(REVIEW_NODE_SELECTORS).length > 0) {
      continue;
    }

    const text = cleanText(element.text());
    if (text.length >= 16 && !isReviewChromeText(text) && !isNonProductCommerceText(text)) {
      texts.push(text);
    }
    if (texts.length >= 40) {
      break;
    }
  }

  return unique(texts).join(" ").slice(0, 8000);
}

/**
 * Keeps only customer-expression keywords. Review keyword slots must never carry
 * OCR/product-copy categories, and bare meta words like "review" or "rating" are
 * page chrome rather than something a customer said.
 */
function customerReviewKeywords(keywords: ClassifiedKeyword[]): ClassifiedKeyword[] {
  return keywords.filter((keyword) =>
    keyword.category === "review" && !GENERIC_REVIEW_META_KEYWORDS.has(cleanText(keyword.keyword).toLowerCase()));
}

function describeReviewStep(reviews: ReviewSummary): string {
  const aggregate = typeof reviews.rating === "number" || typeof reviews.reviewCount === "number"
    ? `평점 ${reviews.rating ?? "-"} / 리뷰수 ${reviews.reviewCount ?? "-"}`
    : "집계 평점 없음";

  return `${aggregate}, 리뷰 본문 ${reviews.items.length}개와 리뷰 키워드 ${reviews.keywords.length}개를 정리했습니다.`;
}

function extractDomReviews($: ReturnType<typeof load>): ReviewItem[] {
  const reviewSelectors = REVIEW_NODE_SELECTORS;
  const seen = new Set<string>();
  const reviews: ReviewItem[] = [];

  for (const node of $(reviewSelectors).toArray()) {
    const element = $(node);
    const hasNestedReview = element.find(reviewSelectors).length > 0;
    const isExplicitReview = element.is("[itemprop='review'], [typeof*='Review'], [data-review]");
    const isLikelyReviewCard = /review[-_\s]?(card|item|tile|entry)|testimonial/i.test(nodeAttributeText($, node));

    if (hasNestedReview && !isExplicitReview && !isLikelyReviewCard) {
      continue;
    }

    const body = reviewBodyText($, node);
    const fingerprint = normalizeFingerprint(body);

    if (body.length < 16 || seen.has(fingerprint) || isReviewChromeText(body)) {
      continue;
    }

    seen.add(fingerprint);
    reviews.push({
      body: body.slice(0, 1200),
      author: firstTextFromSelectors(element, "[itemprop='author'], [class*='author'], [data-author], [class*='user'], [class*='nickname']"),
      rating: extractRatingFromElement($, element),
      datePublished: element.find("time[datetime], [itemprop='datePublished']").first().attr("datetime") ?? firstTextFromSelectors(element, "time, [class*='date']")
    });

    if (reviews.length >= 12) {
      break;
    }
  }

  return reviews;
}

function reviewBodyText($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  const explicit = firstTextFromSelectors(
    element,
    "[itemprop='reviewBody'], [class*='reviewBody'], [class*='review-body'], [class*='content'], [class*='text'], [class*='comment'], p"
  );

  return cleanText(explicit || element.text());
}

function firstTextFromSelectors(element: ReturnType<ReturnType<typeof load>>, selectors: string): string | undefined {
  const text = cleanText(element.find(selectors).first().text());
  return text.length > 0 ? text : undefined;
}

function isReviewChromeText(text: string): boolean {
  return /write a review|sort by|filter|load more|see more reviews|리뷰 작성|정렬|필터/i.test(text) && text.length < 120;
}

function mergeReviewItems(...groups: ReviewItem[][]): ReviewItem[] {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    const fingerprint = normalizeFingerprint(item.body);
    if (fingerprint.length === 0 || seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
}

function extractDomRating($: ReturnType<typeof load>): number | undefined {
  const candidates = [
    ...$("meta[itemprop='ratingValue'], meta[property*='rating'], meta[name*='rating']").toArray().map((node) => $(node).attr("content")),
    ...$("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star'], [aria-label*='out of']")
      .toArray()
      .flatMap((node) => [$(node).attr("content"), $(node).attr("aria-label"), $(node).text()])
  ];

  return candidates.map((value) => parseRatingValue(value)).find((value): value is number => typeof value === "number");
}

function extractDomReviewCount($: ReturnType<typeof load>): number | undefined {
  const candidates = [
    ...$("meta[itemprop='reviewCount'], meta[property*='review_count'], meta[name*='review']").toArray().map((node) => $(node).attr("content")),
    ...$("[itemprop='reviewCount'], [class*='review-count'], [class*='reviewCount'], [data-review-count], [aria-label*='review']")
      .toArray()
      .flatMap((node) => [$(node).attr("content"), $(node).attr("data-review-count"), $(node).attr("aria-label"), $(node).text()])
  ];

  return candidates.map((value) => parseReviewCount(value)).find((value): value is number => typeof value === "number");
}

function extractRatingFromElement($: ReturnType<typeof load>, element: ReturnType<ReturnType<typeof load>>): number | undefined {
  const candidates = [
    element.attr("aria-label"),
    element.attr("data-rating"),
    element.find("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star']").first().attr("content"),
    element.find("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star']").first().attr("aria-label"),
    element.find("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star']").first().text()
  ];

  return candidates.map((value) => parseRatingValue(value)).find((value): value is number => typeof value === "number");
}

function parseRatingValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const text = cleanText(value);
  const explicit = text.match(/([1-5](?:\.\d+)?)\s*(?:out of|\/)\s*5|([1-5](?:\.\d+)?)\s*(?:stars?|점|별점)/i);
  const compact = text.match(/(?:rating|평점|별점)[^\d]{0,20}([1-5](?:\.\d+)?)/i);
  return numberValue(explicit?.[1] ?? explicit?.[2] ?? compact?.[1]);
}

function parseReviewCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const text = cleanText(value);
  const explicit = text.match(/([\d,]+)\s*(?:reviews?|ratings?|개의 리뷰|리뷰|후기|평점)/i);
  return numberValue(explicit?.[1]?.replace(/,/g, "") ?? (/^\d+$/.test(text) ? text : undefined));
}

interface OcrEvidenceCoreResult {
  ocr: OcrExtraction;
  classified: Awaited<ReturnType<typeof classifyOcrCandidates>>;
}

async function extractOcrKeywords(
  $: ReturnType<typeof load>,
  source: string,
  productName: string,
  imageUrls: string[],
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  onProgress?: (message: string) => void,
  collector?: OcrDiagnosticsCollector
): Promise<OcrExtraction> {
  const visionTargets = collectImageOcrTargets($, source, imageUrls, productName);
  const core = await extractOcrEvidenceFromTargets(
    visionTargets,
    collectImageTextCandidates($, source),
    source,
    productName,
    options,
    warnings,
    runtimeSteps,
    onProgress,
    collector
  );
  return core.ocr;
}

async function extractOcrEvidenceFromTargets(
  visionTargets: string[],
  extraCandidates: OcrTextCandidate[],
  source: string,
  productName: string,
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  onProgress?: (message: string) => void,
  collector?: OcrDiagnosticsCollector
): Promise<OcrEvidenceCoreResult> {
  const visionOcrTexts = await extractVisionOcrCandidates(visionTargets, source, productName, options, warnings, runtimeSteps, onProgress, collector);
  const rawCandidates = [
    ...visionOcrTexts,
    ...extraCandidates
  ];
  const orderByImage = new Map<string, number>();
  for (const candidate of rawCandidates) {
    if (!orderByImage.has(candidate.imageUrl)) {
      orderByImage.set(candidate.imageUrl, orderByImage.size);
    }
  }
  const orderedCandidates = rawCandidates.map((candidate) => ({
    ...candidate,
    sourceOrder: candidate.sourceOrder ?? orderByImage.get(candidate.imageUrl) ?? orderByImage.size
  }));
  const evidenceCandidates = orderedCandidates.filter((item) => {
    if (isProductEvidenceCandidate("", item.text)) {
      return true;
    }
    collector?.droppedCandidates.push({
      imageUrl: item.imageUrl,
      reason: "Filtered out as non-product/commerce text before merging.",
      textPreview: ocrTextPreview(item.text)
    });
    return false;
  });
  const imageTexts = mergeOcrCandidates(evidenceCandidates, collector?.mergeStats, OCR_EVIDENCE_LIMIT);

  if (collector) {
    collector.candidatesIn = evidenceCandidates.length;
    collector.candidatesOut = imageTexts.length;
  }

  if (imageTexts.length === 0) {
    return {
      ocr: { imagesScanned: 0, extractedTexts: [] },
      classified: { keywords: [], sentenceInsights: [], confidence: 0 }
    };
  }

  onProgress?.(`${imageTexts.length}개 OCR 텍스트 후보를 reasoning 모델로 의미 분석/문장/키워드 분류 중입니다.`);
  const classified = await classifyOcrCandidates(source, productName, imageTexts, options, warnings, runtimeSteps, collector);

  const ocrResult: OcrExtraction = {
    imagesScanned: imageTexts.length,
    extractedTexts: imageTexts.map((item) => {
      const keywords = mergeKeywords(
        classified.keywords.filter((keyword) => includesKeyword(item.text, keyword.keyword)),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16);

      return {
        imageUrl: item.imageUrl,
        text: item.text,
        confidence: item.confidence ?? classified.confidence,
        keywords,
        sentenceInsights: sentenceInsightsForCandidate(item, classified.sentenceInsights, keywords, classified.confidence),
        ...(item.imageUrls ? { imageUrls: item.imageUrls } : {}),
        ...(item.groups ? { groups: item.groups } : {})
      };
    })
  };

  if (collector) {
    collector.relations = buildOcrRelationDiagnostics(ocrResult.extractedTexts, classified.semanticFacts);
  }

  return { ocr: ocrResult, classified };
}

/**
 * OcrExtraction+분류 결과를 공개 OCR 근거 블록으로 조립한다(순수 함수).
 *
 * Exported for tests only — not part of the package surface (index.ts).
 */
export function assembleImageOcrEvidence(
  ocr: OcrExtraction,
  classifiedSemanticFacts: Partial<GeoSemanticFacts> | undefined,
  classifiedKeywords: ClassifiedKeyword[],
  // 필수 인자다. 기본값을 두었을 때는 인자를 빼먹은 호출부가 차트 계열 귀속을
  // 조용히 끄고, 수치가 주체 없이 발행됐다.
  productName: string
): Pick<ImageOcrEvidenceResult, "ocr" | "keywords"> {
  const sentenceInsights = ocr.extractedTexts.flatMap((item) => item.sentenceInsights);
  const insightFacts = sentenceInsights.length > 0 ? semanticFactsFromSentenceInsights(sentenceInsights) : undefined;
  const layoutClaims = layoutMetricClaimsFromOcr(ocr, productName);
  const skinTypes = skinTypesFromOcr(ocr);
  const layoutFacts = layoutClaims.length > 0 || skinTypes.length > 0
    ? { ...(layoutClaims.length > 0 ? { metricClaims: layoutClaims } : {}), ...(skinTypes.length > 0 ? { skinTypes } : {}) }
    : undefined;
  const semanticFactsParts = [classifiedSemanticFacts, insightFacts, layoutFacts];
  const keywords = toGeoKeywordGroups(mergeKeywords(classifiedKeywords, ocr.extractedTexts.flatMap((item) => item.keywords)));

  return {
    ocr: {
      imageTexts: ocr.extractedTexts.map((item) => ({
        imageUrl: item.imageUrl,
        text: item.text,
        ...(item.imageUrls ? { imageUrls: item.imageUrls } : {}),
        confidence: item.confidence
      })),
      textBlocks: ocr.extractedTexts.map((item) => item.text),
      sentenceInsights: toGeoSentenceInsights(ocr.extractedTexts),
      semanticFacts: semanticFactsParts.some(Boolean) ? mergeSemanticFacts(...semanticFactsParts) : undefined
    },
    keywords
  };
}

/**
 * runtimeSteps를 라벨 단위로 병합해(배치별 중복 스텝 제거) OCR 전용
 * runtimeUsage를 구성한다(순수 함수).
 *
 * Exported for tests only — not part of the package surface (index.ts).
 */
export function buildImageOcrRuntimeUsage(runtimeSteps: RuntimePipelineStep[]): RuntimePipelineUsage | undefined {
  if (runtimeSteps.length === 0) {
    return undefined;
  }
  const steps = mergeRuntimeSteps(runtimeSteps);
  const tokenTotals = mergeTokenUsages(steps.map((step) => step.tokenUsage).filter((usage): usage is AiTokenUsage => Boolean(usage)));
  return {
    steps,
    tokenTotals: tokenTotals ?? {},
    tokenNote: tokenTotals
      ? "Token counts are summed from provider usage metadata returned by model APIs."
      : "Token counts were not returned or do not apply to deterministic/search-only stages."
  };
}

/** 이미지 URL 목록만으로 OCR과 문장-이미지 관계 해석을 수행하는 공개 진입점. */
export async function extractImageOcrEvidence(
  request: ImageOcrEvidenceRequest,
  options: ProductExtractorOptions = {}
): Promise<ImageOcrEvidenceResult> {
  const runtimeOptions = resolveRuntimeRagOptions(options);
  const warnings: AgentWarning[] = [];
  const runtimeSteps: RuntimePipelineStep[] = [];

  const validUrls: string[] = [];
  for (const imageUrl of request.imageUrls) {
    if (/^https?:\/\//i.test(imageUrl)) {
      validUrls.push(imageUrl);
    } else {
      warnings.push({
        code: "IMAGE_OCR_TARGET_SKIPPED",
        message: `Skipped a non-http(s) image OCR target: ${imageUrl.slice(0, 40)}`
      });
    }
  }

  const collector = createOcrDiagnosticsCollector(resolveProviderConfig(runtimeOptions).provider);
  const core = await extractOcrEvidenceFromTargets(
    validUrls,
    [],
    request.source,
    request.productName ?? "",
    runtimeOptions,
    warnings,
    runtimeSteps,
    undefined,
    collector
  );

  const assembled = assembleImageOcrEvidence(
    core.ocr,
    core.classified.semanticFacts,
    core.classified.keywords,
    request.productName ?? ""
  );
  const ocrDiagnostics = finalizeOcrDiagnostics(collector, core.ocr, []);

  return {
    ...assembled,
    diagnostics: {
      ocr: ocrDiagnostics,
      warnings,
      runtimeUsage: buildImageOcrRuntimeUsage(runtimeSteps)
    },
    generatedAt: new Date().toISOString()
  };
}

async function extractVisionOcrCandidates(
  targets: string[],
  source: string,
  productName: string,
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  onProgress?: (message: string) => void,
  collector?: OcrDiagnosticsCollector
): Promise<OcrTextCandidate[]> {
  const providerConfig = resolveProviderConfig(options);

  if (providerConfig.provider === "mock") {
    if (targets.length > 0) {
      warnings.push({
        code: "IMAGE_OCR_PROVIDER_NOT_CONFIGURED",
        message: `${targets.length} product-detail image OCR candidates were found, but image OCR was skipped because the active provider is mock. Configure an image-capable provider such as OpenAI to extract visible text from PDP images.`
      });
    }
    return [];
  }

  if (targets.length === 0) {
    return [];
  }

  const classifier = createKeywordClassifier(providerConfig);

  if (!classifier.extractImageTexts) {
    warnings.push({
      code: "IMAGE_OCR_PROVIDER_NOT_AVAILABLE",
      message: `${targets.length} product-detail image OCR candidates were found, but the active provider does not support visible text extraction from images.`
    });
    return [];
  }

  const preparedInputs = await prepareVisionOcrInputs(targets, warnings, onProgress, collector);
  const extractedTexts: OcrTextCandidate[] = [];
  const failures: string[] = [];
  let quotaOrBillingFailure = false;

  const batches = createVisionOcrBatches(preparedInputs);
  let processedInputCount = 0;

  for (const batch of batches) {
    const batchStart = processedInputCount + 1;
    const batchEnd = processedInputCount + batch.length;
    processedInputCount = batchEnd;
    try {
      onProgress?.(`${preparedInputs.length}개 OCR 이미지 입력 중 ${batchStart}-${batchEnd}번을 OCR 모델로 추출 중입니다.`);
      const extracted = await classifier.extractImageTexts({
        source,
        productName,
        imageUrls: batch.map((input) => input.displayUrl),
        imageInputs: batch
      });
      onProgress?.(`${batchStart}-${batchEnd}번 OCR 이미지 입력에서 ${extracted.images.length}개 텍스트 후보를 수신했습니다.`);
      runtimeSteps.push(createModelRuntimeStep("ocr", "OCR/structure extraction", options, "ocr", extracted.usage, `${batch.length} product-detail image inputs sent for visible text extraction.`));

      const firstReading = extracted.images.map((image) => {
        const slice = parseSliceFragment(image.imageUrl);
        return {
          imageUrl: slice.baseUrl,
          displayUrl: image.imageUrl,
          text: normalizeOcrText(image.text),
          confidence: image.confidence,
          ...(image.groups ? { groups: image.groups } : {}),
          ...(slice.sliceIndex !== undefined ? { sliceIndex: slice.sliceIndex } : {}),
          ...(slice.sliceCount !== undefined ? { sliceCount: slice.sliceCount } : {})
        };
      }).filter((item) => item.text.length >= 8);
      const batchTexts = await verifyOcrBatchReadings({
        classifier,
        source,
        productName,
        batch,
        firstReading,
        collector,
        runtimeSteps,
        options,
        onProgress
      });
      extractedTexts.push(...batchTexts);

      if (collector) {
        for (const item of batchTexts) {
          const targetDiagnostic = ocrTargetDiagnostic(collector, item.imageUrl);
          targetDiagnostic.status = "extracted";
          targetDiagnostic.textLength += item.text.length;
          targetDiagnostic.confidence = minDefinedConfidence(targetDiagnostic.confidence, item.confidence);
          targetDiagnostic.textPreview ??= ocrTextPreview(item.text);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image OCR provider failed.";
      if (collector) {
        for (const input of batch) {
          const targetDiagnostic = ocrTargetDiagnostic(collector, stripSliceFragment(input.displayUrl));
          if (targetDiagnostic.status !== "extracted") {
            targetDiagnostic.status = "failed";
          }
          targetDiagnostic.issues.push(`Image OCR request failed: ${message}`);
        }
      }
      onProgress?.(`${batchStart}-${batchEnd}번 OCR 이미지 추출이 실패했습니다: ${message}`);
      runtimeSteps.push(createModelRuntimeStep(
        "ocr",
        "OCR/structure extraction",
        options,
        "ocr",
        undefined,
        `${batch.length} product-detail images were sent for visible text extraction, but the provider failed: ${message}`
      ));
      failures.push(message);
      if (isQuotaOrBillingError(message)) {
        quotaOrBillingFailure = true;
        break;
      }
    }
  }

  if (failures.length > 0) {
    warnings.push({
      code: quotaOrBillingFailure ? "IMAGE_OCR_QUOTA_EXCEEDED" : "IMAGE_OCR_PROVIDER_FAILED",
      message: quotaOrBillingFailure
        ? "OpenAI image OCR quota exceeded. Check the OpenAI project billing, usage limits, and model access before retrying image OCR."
        : `Image OCR failed for ${failures.length} batch(es): ${unique(failures).slice(0, 2).join(" | ")}`
    });
  }

  const merged = mergeOcrCandidates(joinSliceCandidates(extractedTexts, collector?.mergeStats), collector?.mergeStats);

  if (merged.length === 0 && failures.length === 0) {
    warnings.push({
      code: "IMAGE_OCR_NO_TEXT_EXTRACTED",
      message: `${targets.length} product-detail image OCR candidates were sent to the image OCR provider, but no readable product text was returned. Check image accessibility, OCR model output, or whether the provider can read the target locale.`
    });
  }

  return merged;
}

interface OcrMergeStats {
  duplicatesAbsorbed: number;
  overlapJoins: number;
  /** 슬라이스 경계에서 이어 붙인 그룹 수. */
  layoutSliceStitches: number;
  /** 슬라이스 단계에서 구조를 폐기한 이미지와 사유. */
  layoutDiscarded: Array<{ imageUrl: string; reason: OcrLayoutDiscardReason }>;
  /**
   * 이어붙이지 못한 슬라이스 경계의 실측 기록.
   *
   * 경계가 어긋나면 겹친 줄이 두 번 남고 구조가 폐기된다. 왜 어긋났는지는
   * 그때의 두 판독을 봐야만 알 수 있어(토큰이 빠졌는가, 줄이 다르게 끊겼는가),
   * 실행이 스스로 답을 남기게 한다.
   */
  unmatchedBoundaries: Array<{ imageUrl: string; sliceIndex: number; tailPreview: string; headPreview: string }>;
}

/** Mutable trace filled in while the OCR pipeline runs; finalized into OcrDiagnostics. */
interface OcrDiagnosticsCollector {
  provider: string;
  targetsConsidered: number;
  inputsSent: number;
  targets: Map<string, OcrTargetDiagnostic>;
  mergeStats: OcrMergeStats;
  candidatesIn: number;
  candidatesOut: number;
  droppedCandidates: OcrDroppedTextDiagnostic[];
  classification: OcrDiagnostics["classification"];
  relations?: OcrRelationDiagnostics;
}

function createOcrDiagnosticsCollector(provider: string): OcrDiagnosticsCollector {
  return {
    provider,
    targetsConsidered: 0,
    inputsSent: 0,
    targets: new Map(),
    mergeStats: { duplicatesAbsorbed: 0, overlapJoins: 0, layoutSliceStitches: 0, layoutDiscarded: [], unmatchedBoundaries: [] },
    candidatesIn: 0,
    candidatesOut: 0,
    droppedCandidates: [],
    classification: { batches: 0, failedBatches: 0, providerKeywords: 0, sentenceInsights: 0, confidence: 0 }
  };
}

function ocrTargetDiagnostic(collector: OcrDiagnosticsCollector, imageUrl: string): OcrTargetDiagnostic {
  const existing = collector.targets.get(imageUrl);
  if (existing) {
    return existing;
  }

  const created: OcrTargetDiagnostic = {
    imageUrl,
    sliced: false,
    status: "empty",
    textLength: 0,
    issues: []
  };
  collector.targets.set(imageUrl, created);
  return created;
}

function ocrTextPreview(text: string): string {
  return cleanText(text).slice(0, 160);
}

const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Turns the collected OCR trace plus the final extraction output into the
 * diagnostics block reviewers use to audit OCR quality and to hand problem
 * spots back into a follow-up improvement run.
 */
function finalizeOcrDiagnostics(
  collector: OcrDiagnosticsCollector,
  ocr: OcrExtraction,
  ragChunks: RagChunk[]
): OcrDiagnostics {
  const publicEvidence = ocr.extractedTexts.filter((item) => isProductEvidenceCandidate("", item.text));
  const publicSet = new Set(publicEvidence);
  const unusedTexts: OcrDroppedTextDiagnostic[] = ocr.extractedTexts
    .filter((item) => !publicSet.has(item))
    .map((item) => ({
      imageUrl: item.imageUrl,
      reason: "Excluded from the public geoProduct output as non-product evidence.",
      textPreview: ocrTextPreview(item.text)
    }));
  const sentenceInsightsByCategory: Record<string, number> = {};
  for (const insight of publicEvidence.flatMap((item) => item.sentenceInsights)) {
    sentenceInsightsByCategory[insight.category] = (sentenceInsightsByCategory[insight.category] ?? 0) + 1;
  }

  const targets = Array.from(collector.targets.values());
  for (const target of targets) {
    if (target.status === "empty" && target.issues.length === 0) {
      target.issues.push("No readable text was returned for this image.");
    }
    if (target.status === "extracted" && target.confidence !== undefined && target.confidence < LOW_OCR_CONFIDENCE_THRESHOLD) {
      target.issues.push(`Low transcription confidence (${target.confidence}). Consider re-running OCR for this image.`);
    }
  }

  const issues = unique<string>([
    ...targets.filter((target) => target.status === "failed").map((target) => `Image OCR failed: ${target.imageUrl}`),
    ...targets.filter((target) => target.status === "empty").map((target) => `No readable text extracted: ${target.imageUrl}`),
    ...targets
      .filter((target) => target.status === "extracted" && target.confidence !== undefined && target.confidence < LOW_OCR_CONFIDENCE_THRESHOLD)
      .map((target) => `Low OCR confidence (${target.confidence}): ${target.imageUrl}`),
    collector.classification.failedBatches > 0
      ? `${collector.classification.failedBatches} of ${collector.classification.batches} OCR classification batch(es) failed; keywords from those batches were replaced by heuristics.`
      : undefined,
    collector.droppedCandidates.length > 0
      ? `${collector.droppedCandidates.length} OCR text candidate(s) were dropped as non-product/commerce text before merging (see combination.droppedCandidates).`
      : undefined,
    unusedTexts.length > 0
      ? `${unusedTexts.length} extracted OCR text(s) were excluded from the public output (see utilization.unusedTexts).`
      : undefined
  ]);

  const layout = buildOcrLayoutDiagnostics(ocr, collector.mergeStats);

  return {
    provider: collector.provider,
    targetsConsidered: collector.targetsConsidered,
    inputsSent: collector.inputsSent,
    targets,
    combination: {
      candidatesIn: collector.candidatesIn,
      duplicatesAbsorbed: collector.mergeStats.duplicatesAbsorbed,
      overlapJoins: collector.mergeStats.overlapJoins,
      droppedCandidates: collector.droppedCandidates.slice(0, 20),
      candidatesOut: collector.candidatesOut
    },
    classification: collector.classification,
    utilization: {
      textBlocksInResult: unique(publicEvidence.map((item) => item.text)).length,
      keywordsAttached: ocr.extractedTexts.reduce((sum, item) => sum + item.keywords.length, 0),
      sentenceInsightsByCategory,
      ragChunksFromOcr: ragChunks.filter((chunk) => chunk.kind === "ocr").length,
      unusedTexts: unusedTexts.slice(0, 20)
    },
    issues,
    ...(layout ? { layout } : {}),
    ...(collector.relations ? { relations: collector.relations } : {})
  };
}

/**
 * 레이아웃 관계의 채택·폐기를 집계한다. 검증은 순수 함수이므로 여기서 다시
 * 돌려 "보고된 것"과 "실제로 소비된 것"을 나란히 남긴다 — 그 차이가 프로바이더의
 * 구조 보고 품질이다.
 */
function buildOcrLayoutDiagnostics(ocr: OcrExtraction, mergeStats: OcrMergeStats): OcrLayoutDiagnostics | undefined {
  const reported = ocr.extractedTexts.filter((item) => item.groups && item.groups.length > 0);
  if (reported.length === 0 && mergeStats.layoutDiscarded.length === 0) {
    return undefined;
  }

  const lineRoles: Record<OcrLayoutLineRole, number> = { title: 0, body: 0, label: 0, value: 0, footnote: 0 };
  const structureDiscarded = [...mergeStats.layoutDiscarded];
  let groupsReported = 0;
  let groupsKept = 0;

  for (const item of reported) {
    groupsReported += item.groups?.length ?? 0;
    const verified = verifyOcrLayoutGroups(item.text, item.groups ?? []);
    if (!verified) {
      structureDiscarded.push({ imageUrl: item.imageUrl, reason: "quorum" });
      continue;
    }
    groupsKept += verified.length;
    for (const group of verified) {
      for (const line of group.lines) {
        lineRoles[line.role] += 1;
      }
    }
  }

  return {
    groupsReported,
    groupsKept,
    lineRoles,
    sliceStitches: mergeStats.layoutSliceStitches,
    structureDiscarded,
    ...(mergeStats.unmatchedBoundaries.length > 0
      ? { unmatchedBoundaries: mergeStats.unmatchedBoundaries.slice(0, 12) }
      : {})
  };
}

/**
 * OCR 문장이 어떤 이미지에서 왔고 어떤 방식으로 귀속됐는지, 그리고 그 귀속이 의미적 사실
 * 추출(수치 주장, 성분-효능 링크, 인용)에 얼마나 반영됐는지를 사후 분석용으로 전수 기록한다.
 */
function buildOcrRelationDiagnostics(
  extractedTexts: OcrTextEvidence[],
  semanticFacts: Partial<GeoSemanticFacts> | undefined
): OcrRelationDiagnostics {
  const sentences = extractedTexts.flatMap((item) =>
    item.sentenceInsights.map((insight): OcrRelationSentenceDiagnostic => ({
      text: insight.text,
      category: insight.category,
      imageUrls: insight.imageUrls ?? item.imageUrls ?? [item.imageUrl],
      attribution: insight.attribution ?? "fuzzy"
    }))
  );
  const countLinks = (claims: Array<{ imageUrls?: string[] }> | undefined) => ({
    total: claims?.length ?? 0,
    withImage: claims?.filter((claim) => (claim.imageUrls?.length ?? 0) > 0).length ?? 0
  });

  return {
    sentences: sentences.slice(0, 120),
    attributionCounts: {
      declared: sentences.filter((item) => item.attribution === "declared").length,
      fuzzy: sentences.filter((item) => item.attribution === "fuzzy").length,
      local: sentences.filter((item) => item.attribution === "local").length
    },
    semanticFactLinks: {
      metricClaims: countLinks(semanticFacts?.metricClaims),
      ingredientBenefitLinks: countLinks(semanticFacts?.ingredientBenefitLinks),
      citations: countLinks(semanticFacts?.citations)
    }
  };
}

function createOcrPipelineEvidence(diagnostics: OcrDiagnostics): ExtractionEvidence {
  return {
    field: "ocr.pipeline",
    source: "ocr",
    value: `${diagnostics.targetsConsidered} image target(s) -> ${diagnostics.inputsSent} OCR input(s) -> ${diagnostics.combination.candidatesOut} merged candidate(s) (${diagnostics.combination.overlapJoins} overlap join(s), ${diagnostics.combination.duplicatesAbsorbed} duplicate(s) absorbed) -> ${diagnostics.utilization.textBlocksInResult} public text block(s), ${diagnostics.utilization.ragChunksFromOcr} OCR RAG chunk(s). ${diagnostics.issues.length} issue(s) flagged.`
  };
}

/**
 * Probes each OCR target and expands tall scroll images into overlapping
 * vertical slices so vision models read the copy at usable resolution instead
 * of a downscaled whole. Non-tall or unprobeable targets pass through as-is.
 */
async function prepareVisionOcrInputs(
  targets: string[],
  warnings: AgentWarning[],
  onProgress?: (message: string) => void,
  collector?: OcrDiagnosticsCollector
): Promise<ImageOcrInput[]> {
  const inputs: ImageOcrInput[] = [];
  const unavailableReasons: string[] = [];
  let slicedImageCount = 0;
  let sliceCount = 0;

  if (collector) {
    collector.targetsConsidered = targets.length;
  }

  const preparedTargets = await mapWithConcurrency(targets, IMAGE_OCR_PREPARE_CONCURRENCY, async (target) => ({
    target,
    prepared: await prepareImageOcrInputs(target)
  }));

  for (const { target, prepared } of preparedTargets) {
    const targetDiagnostic = collector ? ocrTargetDiagnostic(collector, target) : undefined;

    if (prepared.sliced) {
      slicedImageCount += 1;
      sliceCount += prepared.inputs.length;
      if (targetDiagnostic) {
        targetDiagnostic.sliced = true;
        targetDiagnostic.sliceCount = prepared.inputs.length;
      }
    }
    if (prepared.slicingUnavailableReason) {
      unavailableReasons.push(prepared.slicingUnavailableReason);
      targetDiagnostic?.issues.push(`Tall image detected but slicing was unavailable, so it was sent whole: ${prepared.slicingUnavailableReason}`);
    }
    inputs.push(...prepared.inputs);
  }

  if (collector) {
    collector.inputsSent = inputs.length;
  }

  if (slicedImageCount > 0) {
    onProgress?.(`세로형 상세 이미지 ${slicedImageCount}장을 ${sliceCount}개 오버랩 조각으로 분할해 고해상도 OCR을 수행합니다.`);
  }
  if (unavailableReasons.length > 0) {
    warnings.push({
      code: "IMAGE_SLICING_UNAVAILABLE",
      message: `${unavailableReasons.length} tall product-detail image(s) were detected but could not be sliced, so they were sent whole and small text may be lost: ${unique(unavailableReasons)[0] ?? ""}`
    });
  }

  return inputs;
}

function createVisionOcrBatches(inputs: ImageOcrInput[]): ImageOcrInput[][] {
  const batches: ImageOcrInput[][] = [];
  let current: ImageOcrInput[] = [];
  let currentLimit = IMAGE_OCR_URL_BATCH_SIZE;
  let currentIsSlice = false;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
  };

  for (const input of inputs) {
    const inputIsSlice = isSliceOrInlineImageOcrInput(input);
    const inputLimit = inputIsSlice ? IMAGE_OCR_SLICE_BATCH_SIZE : IMAGE_OCR_URL_BATCH_SIZE;

    if (current.length > 0 && (inputIsSlice !== currentIsSlice || current.length >= currentLimit)) {
      flush();
    }

    current.push(input);
    currentIsSlice = inputIsSlice;
    currentLimit = inputLimit;
  }

  flush();
  return batches;
}

function isSliceOrInlineImageOcrInput(input: ImageOcrInput): boolean {
  return input.inputUrl.startsWith("data:") || /#ocr-slice-\d+of\d+$/i.test(input.displayUrl);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!, index);
    }
  }));

  return results;
}

function hasOcrProviderWarning(warnings: AgentWarning[]): boolean {
  return warnings.some((warning) =>
    warning.code === "IMAGE_OCR_PROVIDER_FAILED"
    || warning.code === "IMAGE_OCR_QUOTA_EXCEEDED"
    || warning.code === "OCR_PROVIDER_FAILED"
  );
}

function isQuotaOrBillingError(message: string): boolean {
  return /(exceeded your current quota|insufficient_quota|billing|check your plan|rate limit|too many requests)/i.test(message);
}

async function classifyOcrCandidates(
  source: string,
  productName: string,
  imageTexts: OcrTextCandidate[],
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  collector?: OcrDiagnosticsCollector
): Promise<{ keywords: ClassifiedKeyword[]; sentenceInsights: ClassifiedSentenceInsight[]; semanticFacts?: Partial<GeoSemanticFacts>; confidence: number }> {
  if (imageTexts.length === 0) {
    return { keywords: [], sentenceInsights: [], confidence: 0 };
  }

  const classifier = createKeywordClassifier(resolveProviderConfig(options));
  const batches = splitClassificationBatches(imageTexts);
  const batchKeywords: ClassifiedKeyword[][] = [];
  const providerInsights: ClassifiedSentenceInsight[] = [];
  const semanticFactsParts: Array<Partial<GeoSemanticFacts> | undefined> = [];
  let classifiedBatchCount = 0;
  let lastError: unknown;

  for (const [batchIndex, batch] of batches.entries()) {
    const batchLabel = batches.length > 1 ? ` (batch ${batchIndex + 1}/${batches.length})` : "";
    try {
      const classified = await classifier.classifyKeywords(await createKeywordClassificationRequest(source, productName, batch, options, runtimeSteps));
      runtimeSteps.push(createModelRuntimeStep("final", "Semantic OCR classification/reasoning", options, "reasoning", classified.usage, `${batch.length} OCR text candidates semantically classified${batchLabel}.`));
      batchKeywords.push(classified.keywords ?? []);

      const resolveDeclared = <T extends { evidenceIndex?: number; imageUrls?: string[] }>(item: T): T => {
        const declared = item.evidenceIndex !== undefined && item.evidenceIndex >= 1
          ? batch[item.evidenceIndex - 1]
          : undefined;
        if (!declared) {
          // 해석된 선언만 출처가 된다. provider JSON은 캐스팅으로만 검증되므로, 스키마 밖에서
          // 흘러든 imageUrls를 선언으로 오인하면 그 인사이트는 어느 후보에도 붙지 못하고 사라진다.
          return item.imageUrls ? { ...item, imageUrls: undefined } : item;
        }
        return { ...item, imageUrls: declared.imageUrls?.length ? declared.imageUrls : [declared.imageUrl] };
      };

      providerInsights.push(...(classified.sentenceInsights ?? []).map((insight) => {
        const resolved = resolveDeclared(insight);
        return resolved.imageUrls ? { ...resolved, attribution: "declared" as const } : resolved;
      }));
      semanticFactsParts.push(classified.semanticFacts && {
        ...classified.semanticFacts,
        metricClaims: classified.semanticFacts.metricClaims?.map(resolveDeclared),
        ingredientBenefitLinks: classified.semanticFacts.ingredientBenefitLinks?.map(resolveDeclared),
        citations: classified.semanticFacts.citations?.map(resolveDeclared)
      });
      classifiedBatchCount += 1;
    } catch (error) {
      lastError = error;
      runtimeSteps.push(createModelRuntimeStep(
        "final",
        "Semantic OCR classification/reasoning",
        options,
        "reasoning",
        undefined,
        `OCR text classification was called for ${batch.length} candidates${batchLabel} but failed: ${error instanceof Error ? error.message : "OCR keyword provider failed."}`
      ));
    }
  }

  if (collector) {
    collector.classification.batches = batches.length;
    collector.classification.failedBatches = batches.length - classifiedBatchCount;
  }

  if (classifiedBatchCount === 0) {
    warnings.push({
      code: "OCR_PROVIDER_FAILED",
      message: lastError instanceof Error ? lastError.message : "OCR keyword provider failed."
    });
    if (collector) {
      collector.classification.confidence = 0.54;
    }
    const keywords = mergeKeywords(...imageTexts.map((item) => keywordsFromTextAcrossCategories(item.text, "ocr")));
    return {
      keywords,
      sentenceInsights: imageTexts.flatMap((item) =>
        sentenceInsightsForCandidate(
          item,
          [],
          mergeKeywords(keywords.filter((keyword) => includesKeyword(item.text, keyword.keyword)), keywordsFromTextAcrossCategories(item.text, "ocr")),
          0.54
        )
      ),
      confidence: 0.54
    };
  }

  if (classifiedBatchCount < batches.length) {
    warnings.push({
      code: "OCR_PROVIDER_PARTIAL",
      message: `${batches.length - classifiedBatchCount} of ${batches.length} OCR classification batch(es) failed; keywords and sentence insights were merged from the successful batches.`
    });
  }

  const keywords = mergeKeywords(...batchKeywords);
  const sentenceInsights = imageTexts.flatMap((item) =>
    sentenceInsightsForCandidate(
      item,
      providerInsights,
      mergeKeywords(
        keywords.filter((keyword) => includesKeyword(item.text, keyword.keyword)),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16),
      0.72
    )
  );

  if (collector) {
    collector.classification.providerKeywords = keywords.length;
    collector.classification.sentenceInsights = providerInsights.length;
    collector.classification.confidence = 0.72;
  }

  return {
    keywords,
    sentenceInsights: mergeSentenceInsights(sentenceInsights),
    semanticFacts: semanticFactsParts.some(Boolean) ? mergeSemanticFacts(...semanticFactsParts) : undefined,
    confidence: 0.72
  };
}

/**
 * Splits classification evidence into character-budgeted batches so one giant
 * prompt cannot push the model into dropping candidates or truncating output.
 * Candidate order is preserved to keep reading order intact within a batch.
 */
function splitClassificationBatches(imageTexts: OcrTextCandidate[]): OcrTextCandidate[][] {
  const batches: OcrTextCandidate[][] = [];
  let current: OcrTextCandidate[] = [];
  let currentChars = 0;

  for (const item of imageTexts) {
    const itemChars = item.text.length + item.imageUrl.length + 24;
    if (current.length > 0 && currentChars + itemChars > CLASSIFICATION_BATCH_CHAR_LIMIT) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function sentenceInsightsForCandidate(
  candidate: OcrTextCandidate,
  providerInsights: ClassifiedSentenceInsight[],
  keywords: ClassifiedKeyword[],
  confidence: number
): ClassifiedSentenceInsight[] {
  const candidateImageUrls = new Set(candidate.imageUrls?.length ? candidate.imageUrls : [candidate.imageUrl]);
  const normalized = providerInsights
    .map(normalizeProviderSentenceInsight)
    .filter((insight): insight is ClassifiedSentenceInsight => Boolean(insight));

  // 이 후보로 선언된 인사이트. 수치 문장은 후보 텍스트에 같은 수치가 실재하는지 검증해
  // 선언 오류로 환각 수치가 다른 이미지에 귀속되는 것을 막는다.
  const declaredHere = normalized.filter((insight) =>
    insight.imageUrls?.some((url) => candidateImageUrls.has(url))
    && metricTokensAreSupported(insight.text, candidate.text));
  // 다른 후보로 선언된 인사이트는 이 후보의 퍼지 풀에서 제외한다.
  const undeclared = normalized.filter((insight) => !insight.imageUrls || insight.imageUrls.length === 0);
  const fuzzyMatches = undeclared
    .filter((insight) => providerSentenceInsightBelongsToCandidate(insight, candidate, keywords))
    .map((insight) => ({ ...insight, imageUrls: [...candidateImageUrls], attribution: "fuzzy" as const }));

  const localInsights = extractSentenceInsightsFromText(candidate.text, keywords, confidence, candidate.groups)
    .map((insight) => ({ ...insight, imageUrls: [...candidateImageUrls], attribution: "local" as const }));
  // 원문의 절 제목이 역할을 선언한 문장은 그 역할과 경계가 출처 구조 자체다.
  // 모델(또는 목업)의 문장 분할·분류 추측이 그것을 덮으면, 절 관계로 복원한
  // 항목이 다시 다른 절의 본문과 이어붙은 형태로 되돌아간다.
  const sectionDeclared = localInsights.filter((insight) => insight.roleSource === "section-heading");
  const providerMatches = mergeSentenceInsights(declaredHere, fuzzyMatches)
    .filter((insight) => !sectionDeclared.some((declared) => sentenceTextsOverlap(declared.text, insight.text)));
  const remainingLocal = localInsights.filter((insight) => insight.roleSource !== "section-heading");
  const localBackfill = providerMatches.length > 0
    ? remainingLocal.filter((insight) => shouldKeepLocalSentenceBackfill(insight, providerMatches))
    : remainingLocal;

  return mergeSentenceInsights(sectionDeclared, providerMatches, localBackfill).slice(0, 8);
}

/** 두 문장이 같은 원문 구간을 가리키는지. 한쪽이 다른 쪽을 품고 있으면 같은 구간이다. */
function sentenceTextsOverlap(left: string, right: string): boolean {
  const a = normalizeOcrComparisonText(left);
  const b = normalizeOcrComparisonText(right);
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

function extractSentenceInsightsFromText(
  text: string,
  keywords: ClassifiedKeyword[],
  confidence: number,
  groups?: OcrLayoutGroup[]
): ClassifiedSentenceInsight[] {
  return splitOcrEvidenceUnits(text, groups).flatMap((unit): ClassifiedSentenceInsight[] => {
    const sentence = unit.text;
    const sentenceKeywords = mergeKeywords(
      keywords.filter((keyword) => includesKeyword(sentence, keyword.keyword)),
      keywordsFromTextAcrossCategories(sentence, "ocr")
    ).filter((keyword) => keyword.category !== "unknown");
    // 절 제목이 역할을 선언한 항목은 그 역할이 근거다. 본문 어휘로 역할을 다시
    // 추측하면 제형마다 다른 동작 동사를 목록으로 쫓아야 하고, 목록에 없는
    // 동작(세정 단계의 "씻어줍니다")이 그대로 탈락한다.
    const category = unit.declaredCategory ?? inferSentenceInsightCategory(sentence, sentenceKeywords);

    if (!category || category === "unknown") {
      return [];
    }
    if (unit.declaredCategory ? !isDeclaredSectionItemValue(sentence) : !isSentenceInsightValue(sentence, category)) {
      return [];
    }

    const trimmed = trimSentenceInsight(sentence, category);
    return [{
      // 원문이 매긴 서수는 절차의 순서 근거다. 사용법 항목은 그 번호를 달고
      // 나가야 다운스트림이 단일 노트가 아닌 순서 있는 절차로 발행할 수 있다.
      text: unit.declaredCategory === "usage" && unit.ordinal !== undefined ? `${unit.ordinal}. ${trimmed}` : trimmed,
      category,
      keywords: unique(sentenceKeywords.map((keyword) => keyword.keyword)).slice(0, 10),
      confidence,
      source: "ocr",
      roleSource: unit.declaredCategory ? "section-heading" : undefined
    }];
  });
}

function normalizeProviderSentenceInsight(insight: ClassifiedSentenceInsight): ClassifiedSentenceInsight | undefined {
  const text = cleanText(stripSourceSectionLabel(insight.text ?? ""));
  const category = normalizeKeywordCategory(insight.category);

  if (!text || !category || !isSentenceInsightValue(text, category)) {
    return undefined;
  }

  return {
    text: trimSentenceInsight(text, category),
    category,
    keywords: unique((insight.keywords ?? []).map(cleanText)).slice(0, 10),
    confidence: typeof insight.confidence === "number" ? insight.confidence : 0.72,
    source: insight.source === "llm" || insight.source === "mock" ? insight.source : "llm",
    semanticFacts: insight.semanticFacts,
    evidenceIndex: insight.evidenceIndex,
    imageUrls: insight.imageUrls,
    attribution: insight.attribution
  };
}

function providerSentenceInsightBelongsToCandidate(
  insight: ClassifiedSentenceInsight,
  candidate: OcrTextCandidate,
  candidateKeywords: ClassifiedKeyword[]
): boolean {
  if (sentenceBelongsToCandidate(insight.text, candidate.text)) {
    return true;
  }
  if (!metricTokensAreSupported(insight.text, candidate.text)) {
    return false;
  }

  const candidateFingerprint = normalizeFingerprint(candidate.text);
  const directKeywordSupport = unique([
    ...insight.keywords,
    ...candidateKeywords.map((keyword) => keyword.keyword).filter((keyword) => includesKeyword(insight.text, keyword))
  ])
    .map(normalizeSupportTerm)
    .filter((term) => term.length >= 2 && !isWeakSemanticSupportTerm(term))
    .filter((term) => candidateFingerprint.includes(normalizeFingerprint(term))).length;

  if (directKeywordSupport >= 2) {
    return true;
  }
  if (directKeywordSupport >= 1 && categoryHasCandidateEvidence(insight.category, candidate.text)) {
    return true;
  }

  return semanticTokenOverlapSupported(insight.text, candidate.text);
}

function shouldKeepLocalSentenceBackfill(
  localInsight: ClassifiedSentenceInsight,
  providerInsights: ClassifiedSentenceInsight[]
): boolean {
  if (localInsight.category === "metric") {
    const localMetricTokens = normalizedMetricTokenSet(localInsight.text);
    return providerInsights.every((providerInsight) => {
      const providerMetricTokens = normalizedMetricTokenSet(providerInsight.text);
      return localMetricTokens.size > 0 && !setsIntersect(localMetricTokens, providerMetricTokens);
    });
  }

  return providerInsights.every((providerInsight) =>
    providerInsight.category !== localInsight.category
    || !semanticTokenOverlapSupported(providerInsight.text, localInsight.text)
  );
}

function metricTokensAreSupported(insightText: string, candidateText: string): boolean {
  const insightTokens = normalizedMetricTokenSet(insightText);

  if (insightTokens.size === 0) {
    return true;
  }

  const candidateTokens = normalizedMetricTokenSet(candidateText);
  return [...insightTokens].every((token) => candidateTokens.has(token));
}

function normalizedMetricTokenSet(value: string): Set<string> {
  return new Set(unique([
    ...extractMetricPhrases(value),
    ...(value.match(/\b\d+(?:\.\d+)?\s?%/gi) ?? [])
  ]).map((token) => token.toLowerCase().replace(/\s+/g, " ").trim()));
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((item) => right.has(item));
}

function semanticTokenOverlapSupported(insightText: string, candidateText: string): boolean {
  const insightTerms = semanticSupportTerms(insightText);
  const candidateTerms = new Set(semanticSupportTerms(candidateText));
  const overlap = insightTerms.filter((term) => candidateTerms.has(term));
  const threshold = /[가-힣]/.test(insightText) ? 2 : 3;

  return overlap.length >= threshold;
}

function semanticSupportTerms(value: string): string[] {
  const terms = cleanText(value)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{2,}|[가-힣]{2,}/gi) ?? [];

  return unique(terms
    .map(normalizeSupportTerm)
    .filter((term) => term.length >= 2)
    .filter((term) => !/^\d+(?:\.\d+)?$/.test(term))
    .filter((term) => !isWeakSemanticSupportTerm(term)));
}

function normalizeSupportTerm(value: string): string {
  const normalized = cleanText(value).toLowerCase();

  if (/^[가-힣]{3,}$/.test(normalized)) {
    return normalized.replace(/(?:으로|에서|에게|에는|에도|은|는|이|가|을|를|와|과|의|로|에|도|만)$/u, "");
  }

  if (normalized.endsWith("'s")) {
    return normalized.slice(0, -2);
  }

  return normalized.length > 4 && normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
}

function isWeakSemanticSupportTerm(value: string): boolean {
  return WEAK_SEMANTIC_SUPPORT_TERMS.has(value);
}

function categoryHasCandidateEvidence(category: KeywordCategory, candidateText: string): boolean {
  if (category === "ingredient") {
    return isSemanticFieldValue(candidateText, "ingredient");
  }
  if (category === "benefit") {
    return isSemanticFieldValue(candidateText, "benefit");
  }
  if (category === "effect") {
    return isSemanticFieldValue(candidateText, "effect");
  }
  if (category === "usage") {
    return isUsageInstructionSentence(candidateText);
  }
  if (category === "metric") {
    return isSemanticFieldValue(candidateText, "metric");
  }

  return true;
}

/**
 * 절 제목이 선언할 수 있는 역할. 문장 인사이트가 실을 수 있는 역할로 좁힌다
 * ("rating"처럼 문장 단위 역할이 아닌 값은 제외).
 */
type DeclaredSectionRole = Extract<ProductContentCategory, KeywordCategory>;

/** 값이 실릴 수 있는 상품 필드의 역할. 어휘 게이트와 면제가 함께 쓰는 목록이다. */
type ProductFieldRole = "benefit" | "effect" | "ingredient" | "usage";

/** 절 관계를 달고 나오는 OCR 근거 단위. */
interface OcrEvidenceUnit {
  text: string;
  declaredCategory?: DeclaredSectionRole;
  ordinal?: number;
}

/**
 * OCR 블록을 절 관계(제목 → 서수 항목)로 읽어 근거 단위를 만든다.
 *
 * 제목이 역할을 선언한 절의 항목은 그 역할을 달고 나가고, 제목이 없는 영역은
 * 종전대로 문장 단위로 분해한다. 관계를 먼저 세우기 때문에 다른 절의 본문이
 * 이어붙거나 제목 문자열이 값 안으로 섞이지 않는다.
 */
function splitOcrEvidenceUnits(text: string, groups?: OcrLayoutGroup[]): OcrEvidenceUnit[] {
  // 관계를 모델이 보고했으면 그것을 쓴다. 레이아웃이 실제로 묶어 둔 관계는
  // 줄 순서로 복원할 수 없는 것까지 담고 있다 — 나란한 패널의 경계, 차트의
  // 값과 눈금, 각주가 한정하는 대상.
  //
  // 보고가 없거나 전사가 뒷받침하지 않으면 줄 파서로 되돌아간다. 제목처럼
  // 생긴 줄은 역할을 알아보든 못 알아보든 절 경계다 — 경계 판정과 역할 판정을
  // 분리해야 역할을 모르는 제목("추천 피부 타입")이 앞 절의 항목이 되어 그
  // 절의 역할을 뒤집어쓰지 않는다.
  const verifiedGroups = groups ? verifyOcrLayoutGroups(text, groups) : undefined;
  const sections = verifiedGroups ? ocrLayoutSections(verifiedGroups) : parseOcrBlockSections(text);
  const units = sections.flatMap((section) => {
    const declaredCategory = section.heading ? sectionHeadingCategory(section.heading) : undefined;
    return section.items.flatMap((item): OcrEvidenceUnit[] => {
      // 이미지 한 장이 줄바꿈 없이 한 덩어리로 오면 절 구조가 없다. 그때만
      // 인라인 서수 복구가 필요하다.
      const inlineSequence = extractExplicitNumberedUsageSteps(item.text);
      if (inlineSequence.steps.length >= 2) {
        return [
          ...inlineSequence.steps.map((step) => ({
            text: step.text,
            declaredCategory: "usage" as const,
            ordinal: step.ordinal
          })),
          ...segmentItemSentences(inlineSequence.remainder).map((value) => ({ text: value }))
        ];
      }
      // 측정 행("사용 전 … 사용 직후 … 105% 개선")은 자기 안에 시험 구조를
      // 갖고 있다. 절 제목은 주제를 선언할 뿐이므로, 그런 행이 효능·성분 절에
      // 놓였다는 이유로 그 절의 주장으로 발행되면 안 된다. 측정은 측정 경로로
      // 보낸다.
      const declaresMeasurementRow = declaredCategory !== undefined
        && declaredCategory !== "effect"
        && declaredCategory !== "metric"
        && isMeasurementTimelineSentence(item.text);
      if (declaredCategory && !declaresMeasurementRow) {
        return [{ text: item.text, declaredCategory, ordinal: item.ordinal }];
      }
      return segmentItemSentences(item.text).map((value) => ({ text: value }));
    });
  });

  const seen = new Set<string>();
  return units
    .map((unit) => ({ ...unit, text: cleanText(stripSourceSectionLabel(unit.text.replace(/\s+/g, " "))) }))
    .filter((unit) => unit.text && isPublishableOcrEvidenceUnit(unit))
    .filter((unit) => {
      const key = unit.text.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16);
}

/**
 * 절 제목이 선언하는 역할. DOM 섹션 제목과 같은 분류기를 쓴다 — 제목에서
 * 역할을 읽는 규칙이 두 벌로 갈라지면 한쪽만 갱신되기 때문이다.
 */
function sectionHeadingCategory(heading: string): DeclaredSectionRole | undefined {
  if (isMeasurementAxisLabel(heading)) {
    return undefined;
  }
  const category = sectionCategory(heading, "", []);
  return category === "unknown" || category === "rating" ? undefined : category;
}

/**
 * 비교 축의 눈금 라벨("사용 전", "세정 후", "4주 후", "Before")은 절을 여는
 * 제목이 아니라 두 이미지를 견주는 축의 이름이다. 제목으로 읽으면 그 뒤에
 * 오는 시험 문장 전체가 그 라벨의 역할을 뒤집어쓴다 — "사용 전"이 사용법 절을
 * 선언해 임상 수치가 사용 단계로 발행되는 식이다.
 */
function isMeasurementAxisLabel(value: string): boolean {
  const text = cleanText(value);
  if (!text || text.split(/\s+/u).length > MAX_AXIS_LABEL_WORDS) {
    return false;
  }
  // 눈금은 시점만 가리킨다. 결과어나 측정 수치가 함께 있으면 그것은 축의 이름이
  // 아니라 주장이다("4주 후 수분 105% 개선").
  if (/[%％]/u.test(text) || METRIC_DIRECTION_WORD.test(text)) {
    return false;
  }
  return TEMPORAL_REFERENCE.test(text);
}

/** 눈금 라벨의 길이. 축의 이름은 시점 하나를 가리키므로 짧다. */
const MAX_AXIS_LABEL_WORDS = 4;

/**
 * 시점을 가리키는 표지.
 *
 * 형태를 열거하던 때는 목록에 없는 눈금이 제목으로 읽혔다 — `제품 사용 후`,
 * `1회 사용 후`, `도포 4주 후`, `After 4 weeks`, `Week 4`, `Baseline`이 모두
 * 그랬다. 시간 지시는 어느 상품이 와도 같은 닫힌 부류이므로(의존명사 `전·후·뒤`,
 * 기간 단위, 영문 시간 명사), 형태 조합이 아니라 그 부류로 규정한다.
 */
const TEMPORAL_REFERENCE = /(?:^|\s)(?:전|후|뒤|직후|중)(?:$|\s)|\d+(?:\.\d+)?\s*(?:주|일|개월|시간|년)|\b(?:before|after|baseline|initial|later|weeks?|days?|months?|hours?)\b/iu;

/** 측정이 움직인 방향. 이것이 있으면 그 줄은 시점이 아니라 결과다. */
const METRIC_DIRECTION_WORD = /(?:개선|증가|감소|상승|향상|회복|완화|잔존|지속)|\b(?:improv|increas|decreas|reduc|recover)/iu;

function isPublishableOcrEvidenceUnit(unit: OcrEvidenceUnit): boolean {
  if (unit.declaredCategory) {
    // 절 관계가 이미 역할을 정했으므로 역할 추측은 건너뛴다. 값 자격은 남는다 —
    // 짧은 항목("가벼운 메이크업 세정력")은 원문이 세운 하나의 값이지만, 수치만
    // 남은 줄과 각주는 값이 아니다.
    return unit.text.length >= 6
      && hasPredicatedMeasurement(unit.text)
      && !isFootnoteLine(unit.text);
  }
  return unit.text.length >= 12
    && !isLikelyStandaloneOcrHeading(unit.text)
    && (unit.text.split(/\s+/).length >= 3 || /[가-힣ぁ-んァ-ン]/.test(unit.text));
}

/**
 * 절 항목의 발행 가능성.
 *
 * 역할은 관계가 정했으므로 역할을 다시 추측하지 않는다. 그러나 **값이 될 수
 * 있는지**는 여전히 그 줄의 형태가 정한다 — 이 두 질문을 하나로 묶어 선언
 * 경로에서 값 자격 검사를 통째로 면제했더니, 배지 눈금(`+63.6%`)과 규격
 * (`7.05 oz. / 200 g`)과 시험 고지(`※ …시험 결과`)가 효능 주장으로 발행됐다.
 */
function isDeclaredSectionItemValue(value: string): boolean {
  const text = cleanText(value);
  return text.length >= 6
    && text.length <= 900
    && !isNonProductCommerceText(text)
    && hasPredicatedMeasurement(text)
    && !isFootnoteLine(text);
}

const USAGE_SEQUENCE_HEADER_PATTERN = /(?:사용\s*방법|사용법|how\s*to\s*use|directions?|使い方|使用方法)\s*[.:：]?\s*/iu;

/**
 * OCR frequently merges an explicit numbered usage sequence ("사용법 1 ... 2 ...",
 * "HOW TO USE Step 1 ... Step 2 ...") into one block together with package label
 * text (brand names, volume, marketing captions). Rescue the ordered steps as
 * standalone sentences before generic sentence segmentation so they survive as
 * usage evidence, and strip the matched span from the remainder so the label
 * noise cannot masquerade as a usage instruction. Each rescued step keeps its
 * explicit source numbering ("1. ...", "2. ...") because downstream HowTo
 * composition may only publish a multi-step procedure when the source order is
 * explicit.
 */
function extractExplicitNumberedUsageSteps(text: string): { steps: Array<{ ordinal: number; text: string }>; remainder: string } {
  const noSequence = { steps: [] as Array<{ ordinal: number; text: string }>, remainder: text };
  const cleaned = cleanText(text);
  const headerMatch = USAGE_SEQUENCE_HEADER_PATTERN.exec(cleaned);
  if (!headerMatch) {
    return noSequence;
  }

  const body = cleaned.slice(headerMatch.index + headerMatch[0].length);
  const steps: Array<{ ordinal: number; text: string }> = [];
  let cursor = 0;

  for (let position = 1; ; position += 1) {
    const marker = new RegExp(`(?:^|\\s)(?:step\\s*)?${position}\\s*(?:단계|段階)?[.):、]?\\s+`, "iu").exec(body.slice(cursor));
    if (!marker || (position === 1 && marker.index > 24)) {
      break;
    }
    const stepStart = cursor + marker.index + marker[0].length;
    const nextMarker = new RegExp(`(?:^|\\s)(?:step\\s*)?${position + 1}\\s*(?:단계|段階)?[.):、]?\\s+`, "iu").exec(body.slice(stepStart));
    const rawStep = nextMarker ? body.slice(stepStart, stepStart + nextMarker.index) : body.slice(stepStart);
    const sentenceEnd = rawStep.search(/[.!?。！？](?:\s|$)/u);
    const stepText = cleanText(sentenceEnd >= 0 ? rawStep.slice(0, sentenceEnd + 1) : rawStep);
    if (stepText.length < 8) {
      break;
    }
    steps.push({ ordinal: position, text: stepText });
    cursor = nextMarker
      ? stepStart + nextMarker.index
      : stepStart + (sentenceEnd >= 0 ? sentenceEnd + 1 : rawStep.length);
    if (!nextMarker) {
      break;
    }
  }

  if (steps.length < 2) {
    return noSequence;
  }

  const remainder = cleanText(`${cleaned.slice(0, headerMatch.index)} ${body.slice(cursor)}`);
  return { steps, remainder };
}

function isLikelyStandaloneOcrHeading(value: string): boolean {
  const text = cleanText(value);
  const words = text.split(/\s+/);

  if (isFullIngredientLabel(text)) {
    return false;
  }
  if (words.length > 8 || /[.!?。！？]/.test(text)) {
    return false;
  }
  if (/\b(?:is|are|was|were|has|have|combines?|contains?|supports?|helps?|enhances?|improves?|diminish(?:es|ed)?)\b/i.test(text)) {
    return false;
  }

  return /[A-Z가-힣]/.test(text) && /(effect|ingredient|benefit|formula|peptide|ginseng|효능|효과|성분|원료)/i.test(text);
}

function isFullIngredientLabel(value: string): boolean {
  return /^(?:ingredients?|전성분|全成分)\s*:/i.test(cleanText(value));
}

function inferSentenceInsightCategory(sentence: string, keywords: ClassifiedKeyword[]): KeywordCategory | undefined {
  const text = sentence.toLowerCase();

  if (isNonProductCommerceText(sentence)) {
    return "unknown";
  }
  if (isMeasurementTimelineSentence(sentence)) {
    return /\d|%/.test(sentence) ? "metric" : "effect";
  }
  if (isUsageInstructionSentence(sentence)) {
    return "usage";
  }
  if (/(clinical|result|after\s+\d|showed|agreed|improvement|improved|enhances?|diminish|diminished|visible signs|wrinkles?|fine lines|firmness|firmer|elasticity|resilience|texture|even|효과|결과|개선|주름|피부결|탄력)/i.test(sentence)) {
    return "effect";
  }
  if (/(ingredient|formula|blend|peptide|ginseng|retinol|niacinamide|hyaluronic|ceramide|panax|extract|성분|원료|인삼|펩타이드|레티놀)/i.test(sentence)) {
    return "ingredient";
  }
  if (/(benefit|hydration|moisture|moisturizing|soothing|brightening|barrier|radiance|plumpness|보습|수분|진정|장벽|광채|자생력|고밀도)/i.test(sentence)) {
    return "benefit";
  }
  if (/\b\d+(?:\.\d+)?\s?(?:%|weeks?|days?|hours?|ml|mL|oz|drops?|pumps?)\b|\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b/i.test(sentence)) {
    return "metric";
  }
  if (/(review|customer|rating|stars?|리뷰|후기|평점)/i.test(sentence)) {
    return "review";
  }
  if (text.includes("?") || /(faq|question|answer|자주|질문|답변)/i.test(sentence)) {
    return "faq";
  }

  const ranked = new Map<KeywordCategory, number>();
  for (const keyword of keywords) {
    ranked.set(keyword.category, (ranked.get(keyword.category) ?? 0) + keyword.confidence);
  }

  return [...ranked.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function isMeasurementTimelineSentence(value: string): boolean {
  const text = cleanText(value);

  return /((?:사용|도포)\s*(?:전|직후|후)|사용\s+\d|before use|after use|immediately after use|after\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?))/i.test(text)
    && /(결과|개선|효과|측정|수분|보습|장벽|피부결|탄력|주름|%|\d|clinical|result|improv|hydration|moisture|barrier|texture|firmness|wrinkle)/i.test(text)
    && !hasStrongUsageInstructionCue(text);
}

function isUsageInstructionSentence(value: string): boolean {
  const text = cleanText(value);

  return hasUsageInstructionCue(text)
    && !isMeasurementTimelineSentence(text);
}

/**
 * Bare `도포` can describe a clinical control or measurement condition (for
 * example `무도포 대조 부위` or `1회 도포 후 18시간`). Keep those phrases
 * from masquerading as an actionable how-to instruction.
 */
function hasUsageInstructionCue(value: string): boolean {
  const text = cleanText(value).replace(/(?:무|미|비)\s*도포/gi, "");

  return hasStrongUsageInstructionCue(text)
    || /도포(?!\s*(?:전|직후|후|대조|부위|군))/i.test(text);
}

function hasStrongUsageInstructionCue(value: string): boolean {
  return /(how to use|directions?|apply|dispense|massage|rinse|morning|night|routine|pump|drops?|spray|spritz|사용법|사용 방법|사용방법|바르|펴\s*발|적당량|덜어|펌프|펌핑|아침|저녁|루틴|두드려|흡수시켜|분사|뿌려|뿌리(?:세요|십시오)|스프레이|朝|夜|噴射|スプレー)/i.test(cleanText(value));
}

function isSentenceInsightValue(value: string, category: KeywordCategory): boolean {
  const text = cleanText(value);
  const maxLength = category === "ingredient" && isFullIngredientList(text) ? 3000 : 900;

  if (text.length < 12 || text.length > maxLength || isNonProductCommerceText(text)) {
    return false;
  }
  if (category === "product" || category === "price" || category === "trend") {
    return false;
  }
  if (category === "metric") {
    return hasPredicatedMeasurement(text)
      && (isSemanticFieldValue(text, "metric") || /(clinical|result|agreed|showed|after\s+\d)/i.test(text));
  }
  if (category === "faq" || category === "review") {
    return true;
  }

  return isSemanticFieldValue(text, category);
}

/**
 * 측정 주장은 "무엇이 어떻게 되었는지"를 말한다. 수치·단위·구분기호를 걷어낸
 * 뒤에 아무 내용어도 남지 않는 줄("7.05 oz. / 200 g", "+63.6%")은 규격이나
 * 배지 눈금이지 측정 결과를 말하는 문장이 아니다. 어떤 단위 목록을 열거하는
 * 대신, 남는 말이 있는지를 본다.
 */
function hasPredicatedMeasurement(value: string): boolean {
  return figureFreeRemainder(value).length >= 2;
}

/**
 * 수치와 그에 붙은 단위를 걷어낸 뒤 남는 말.
 *
 * 단위 목록은 열거하지 않는다 — 형제 모듈(`ocr-layout-metrics.ts`)이 같은
 * 판단을 이미 그렇게 규정했다("목록으로 규정하면 새 단위가 올 때마다 깨진다").
 * 값 라인은 숫자 하나와 그에 붙은 짧은 표기로 이루어지므로, 숫자 뒤에 남는
 * 짧은 비숫자 꼬리가 곧 단위다. 열거했을 때는 `120 mmHg`·`1.7 ㎍/㎖`가 목록에
 * 없어 측정 주장으로 통과했다.
 */
function figureFreeRemainder(value: string): string {
  return cleanText(value)
    .replace(/[+\-−±]?\d+(?:[.,]\d+)?\s*(?:[^\s\d]{1,4})?/gu, " ")
    .replace(/[%％]|[+\-−±*＊※·•]|[()[\]{}]|[/／,、.:;~〜]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * 참조 기호로 시작하는 줄은 각주다.
 *
 * 각주는 절의 주장이 아니라 그 절이 실은 수치의 조건이다(`※ 성인 여성 30명
 * 대상 4주 사용 시험 결과`). 어휘가 아니라 조판 형태로 규정한다 — 시험 고지는
 * 어느 브랜드에서나 이 기호로 열린다.
 */
function isFootnoteLine(value: string): boolean {
  return /^\s*[※*＊†‡]/u.test(cleanText(value));
}

function trimSentenceInsight(value: string, category: KeywordCategory): string {
  const text = cleanText(value);
  const limit = category === "ingredient"
    ? isFullIngredientList(text) ? 2400 : 520
    : 360;

  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function isFullIngredientList(value: string): boolean {
  const text = cleanText(stripSourceSectionLabel(value));
  if (isFullIngredientLabel(text) && text.replace(/^(?:ingredients?|전성분|全成分)\s*:?\s*/i, "").length >= 12) {
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

function sentenceBelongsToCandidate(sentence: string, candidateText: string): boolean {
  const sentenceKey = normalizeFingerprint(sentence);
  const candidateKey = normalizeFingerprint(candidateText);

  if (sentenceKey.length < 12 || candidateKey.length < 12) {
    return false;
  }

  return candidateKey.includes(sentenceKey.slice(0, 120)) || sentenceKey.includes(candidateKey.slice(0, 120));
}

/**
 * Case-insensitive keyword containment with a normalized-fingerprint fallback
 * so Korean spacing/particle variants (e.g. "피부 장벽" vs "피부장벽") still match
 * the OCR candidate they came from.
 */
function includesKeyword(text: string, keyword: string): boolean {
  if (text.toLowerCase().includes(keyword.toLowerCase())) {
    return true;
  }

  const normalizedKeyword = normalizeOcrComparisonText(keyword);
  return normalizedKeyword.length >= 2 && normalizeOcrComparisonText(text).includes(normalizedKeyword);
}

function normalizeKeywordCategory(category: KeywordCategory): KeywordCategory | undefined {
  return [
    "product",
    "price",
    "benefit",
    "effect",
    "ingredient",
    "usage",
    "faq",
    "review",
    "metric",
    "trend",
    "unknown"
  ].includes(category) ? category : undefined;
}

function mergeSentenceInsights(...groups: ClassifiedSentenceInsight[][]): ClassifiedSentenceInsight[] {
  const seen = new Set<string>();
  return groups.flat().filter((insight) => {
    const key = `${insight.category}:${normalizeFingerprint(insight.text).slice(0, 160)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return insight.text.length > 0;
  });
}

function createOcrSentenceSignalBuckets(ocr: OcrExtraction): ProductSectionBuckets {
  return createSentenceSignalBuckets(ocr.extractedTexts.flatMap((item) => item.sentenceInsights));
}

function createSentenceSignalBuckets(insights: ClassifiedSentenceInsight[]): ProductSectionBuckets {
  const buckets: ProductSectionBuckets = {
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    sections: []
  };

  for (const insight of insights) {
    if (insight.category === "benefit") {
      buckets.benefits.push(insight.text);
    }
    if (insight.category === "effect") {
      buckets.effects.push(insight.text);
    }
    if (insight.category === "ingredient") {
      buckets.ingredients.push(insight.text);
    }
    if (insight.category === "usage") {
      buckets.usage.push(insight.text);
    }
    if (insight.category === "metric" || /\d|%|weeks?|days?|hours?|주|일|시간/.test(insight.text)) {
      buckets.metrics.push(...extractMetricPhrases(insight.text));
    }
  }

  const declared = declaredSectionTexts(insights);
  const field = (values: string[], category: ProductFieldRole, limit: number) =>
    valuesWithDeclaredRelationsExempt(values, declared, category, limit);

  return {
    benefits: field(buckets.benefits, "benefit", 12),
    effects: field(buckets.effects, "effect", 12),
    ingredients: field(buckets.ingredients, "ingredient", 16),
    usage: field(buckets.usage, "usage", 12),
    metrics: unique(buckets.metrics).slice(0, 16),
    sections: []
  };
}

/** 절 제목이 역할을 선언해 준 문장들의 본문. */
function declaredSectionTexts(insights: ClassifiedSentenceInsight[]): Set<string> {
  return new Set(insights
    .filter((insight) => insight.roleSource === "section-heading")
    .map((insight) => cleanText(insight.text))
    .filter((text) => text.length > 0));
}

/**
 * 어휘 게이트를 지나되, 관계로 역할이 확정된 값은 면제한다.
 *
 * 재검증은 역할이 **추측**일 때 필요한 방어다. 원문 절 제목이 역할을 선언한 값에
 * 다시 걸면 그 목록에 없는 정상 문장(세정 단계, 짧은 효능 항목)이 마지막 단계에서
 * 사라진다.
 *
 * 이 규정이 두 곳에 서로 다른 기법으로 구현되어 있었다 — 한쪽은 버킷을 둘로
 * 나누고, 한쪽은 본문 Set을 들고 걸렀다. 면제 카테고리를 늘리거나 본문 길이
 * 처리를 바꾸면 한쪽만 갱신되어 값이 다시 사라진다.
 */
function valuesWithDeclaredRelationsExempt(
  values: string[],
  declared: Set<string>,
  category: ProductFieldRole,
  limit: number
): string[] {
  return unique([
    ...values
      .map(cleanText)
      .filter((value) => declared.has(value) && !isNonProductCommerceText(value)),
    ...semanticFieldValues(values, category, limit)
  ]).slice(0, limit);
}

/**
 * 원문이 밝힌 피부 타입. 문장이 주장 자격을 갖췄는지 묻지 않는다.
 *
 * 피부 타입은 주장이 아니라 표기다 — "추천 피부 타입: 건조 피부 또는 민감 피부"는
 * 무엇이 개선된다는 말이 아니라 이 제품이 누구를 위한 것인지 밝히는 라벨이다.
 * 그런데 추출이 문장 인사이트에만 의존해, 그 라벨 절의 역할을 알아보지 못하면
 * (`RECOMMENDED FOR`, `추천 피부 타입`) 인사이트가 만들어지지 않아 타입이 통째로
 * 사라졌다. 표기는 원문에서 바로 읽는다.
 */
function skinTypesFromOcr(ocr: OcrExtraction): string[] {
  return unique(ocr.extractedTexts.flatMap((item) => skinTypesStatedIn(item.text)));
}

/**
 * 한 이미지의 원문에서 **긍정으로 밝힌** 피부 타입만 읽는다.
 *
 * 원문은 배제도 함께 적는다("지성 피부에는 권장하지 않습니다", "Not recommended
 * for oily skin"). 전문을 한 덩어리로 읽으면 그 배제 대상이 추천 타입으로
 * 발행된다 — 제품이 권장하지 않는 대상을 추천으로 뒤집는 셈이다.
 *
 * 문장 단위로 갈라 부정된 문장을 버린다. 한국어의 부정은 어휘가 아니라
 * 구문이다(`-지 않다`·`-지 말다`·`못`), 영문은 부정어가 닫힌 부류다.
 */
function skinTypesStatedIn(value: string): string[] {
  return unique(cleanText(value)
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .filter((sentence) => !KOREAN_NEGATED_PREDICATE.test(sentence) && !ENGLISH_NEGATOR.test(sentence))
    .flatMap((sentence) => extractSkinTypeSignals(sentence)));
}

/** `-지 않다`·`-지 말다`·`못` — 한국어가 부정을 만드는 구문. */
const KOREAN_NEGATED_PREDICATE = /(?:지\s*(?:않|말)|못\s*[가-힣]|삼가|금지|비추천)/u;

/** 영문 부정어. 닫힌 부류다. */
const ENGLISH_NEGATOR = /\b(?:not|never|no|avoid|unsuitable|except)\b|n't\b/iu;

function layoutMetricClaimsFromOcr(ocr: OcrExtraction, productName: string): GeoSemanticMetricClaim[] {
  return ocr.extractedTexts.flatMap((item) => {
    if (!item.groups) {
      return [];
    }
    const verified = verifyOcrLayoutGroups(item.text, item.groups);
    if (!verified) {
      return [];
    }
    const imageUrls = item.imageUrls ?? [item.imageUrl];
    return metricClaimsFromOcrLayout(verified, productName)
      .map((claim) => ({ ...claim, ...(imageUrls.length > 0 ? { imageUrls } : {}) }));
  });
}

function semanticFactsFromExtraction(product: ProductProfile, ocr: OcrExtraction, modelFacts?: Partial<GeoSemanticFacts>): GeoSemanticFacts {
  const insightFacts = semanticFactsFromSentenceInsights(ocr.extractedTexts.flatMap((item) => item.sentenceInsights));
  const layoutFacts: Partial<GeoSemanticFacts> = {
    metricClaims: layoutMetricClaimsFromOcr(ocr, product.name),
    skinTypes: skinTypesFromOcr(ocr)
  };
  return mergeSemanticFacts({
    ingredients: product.ingredients,
    benefits: product.benefits,
    effects: product.effects,
    skinTypes: [],
    usageSteps: product.usage,
    metricClaims: product.metrics.map((sentence) => ({ sentence, sourceText: sentence })),
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }, insightFacts, layoutFacts, modelFacts);
}

function semanticFactsFromSentenceInsights(insights: ClassifiedSentenceInsight[]): GeoSemanticFacts {
  return mergeSemanticFacts(...insights.map((insight): Partial<GeoSemanticFacts> => ({
    ingredients: insight.category === "ingredient" ? semanticKeywordOrSentenceValues(insight) : [],
    benefits: insight.category === "benefit" ? [insight.text] : [],
    effects: insight.category === "effect" ? [insight.text] : [],
    // 부정 검사를 지나는 한 곳으로 모은다. 여기서 `extractSkinTypeSignals`를
    // 직접 부르던 때는 같은 판정이 두 벌이 되어, 원문이 배제한 타입이 이 경로로
    // 다시 들어왔다.
    skinTypes: skinTypesStatedIn(insight.text),
    usageSteps: insight.category === "usage" ? [insight.text] : [],
    metricClaims: insight.category === "metric" || hasMetricSignal(insight.text)
      ? [{ sentence: insight.text, sourceText: insight.text, ...(insight.imageUrls ? { imageUrls: insight.imageUrls } : {}) }]
      : [],
    evidenceSentences: [insight.text],
    citations: [],
    ingredientBenefitLinks: insight.category === "ingredient" && hasBenefitOrEffectLanguage(insight.text)
      ? [{ sentence: insight.text, sourceText: insight.text, ...(insight.imageUrls ? { imageUrls: insight.imageUrls } : {}) }]
      : [],
    ...insight.semanticFacts
  })));
}

function semanticKeywordOrSentenceValues(insight: ClassifiedSentenceInsight): string[] {
  return insight.keywords.length > 0 ? insight.keywords : [insight.text];
}

function mergeSemanticFacts(...items: Array<Partial<GeoSemanticFacts> | undefined>): GeoSemanticFacts {
  return {
    ingredients: unique(items.flatMap((item) => arrayValues(item?.ingredients)).map(cleanText)).slice(0, 20),
    benefits: unique(items.flatMap((item) => arrayValues(item?.benefits)).map(cleanText)).slice(0, 20),
    effects: unique(items.flatMap((item) => arrayValues(item?.effects)).map(cleanText)).slice(0, 20),
    skinTypes: unique(items.flatMap((item) => arrayValues(item?.skinTypes)).map(cleanText)).slice(0, 12),
    usageSteps: unique(items.flatMap((item) => arrayValues(item?.usageSteps)).map(cleanText).filter(isUsageInstructionSentence)).slice(0, 12),
    metricClaims: uniqueSemanticMetricClaims(items.flatMap((item) => Array.isArray(item?.metricClaims) ? item.metricClaims : [])).slice(0, 16),
    evidenceSentences: unique(items.flatMap((item) => arrayValues(item?.evidenceSentences)).map(cleanText)).slice(0, 24),
    ingredientBenefitLinks: uniqueSemanticIngredientBenefitLinks(items.flatMap((item) => Array.isArray(item?.ingredientBenefitLinks) ? item.ingredientBenefitLinks : [])).slice(0, 16),
    citations: uniqueSemanticCitations(items.flatMap((item) => Array.isArray(item?.citations) ? item.citations : [])).slice(0, 12)
  };
}

function uniqueSemanticCitations(values: NonNullable<GeoSemanticFacts["citations"]>): NonNullable<GeoSemanticFacts["citations"]> {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = cleanText([
      value.type, value.title, value.publisher, value.author, value.publishedAt,
      value.url, value.finding, value.sourceText
    ].filter(Boolean).join(" ")).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSemanticMetricClaims(values: GeoSemanticMetricClaim[]): GeoSemanticMetricClaim[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const claim: GeoSemanticMetricClaim = {
      label: stringValue(value.label),
      subject: stringValue(value.subject),
      value: stringValue(value.value),
      unit: stringValue(value.unit),
      metric: stringValue(value.metric),
      direction: stringValue(value.direction),
      timing: stringValue(value.timing),
      comparator: stringValue(value.comparator),
      baseline: stringValue(value.baseline),
      period: stringValue(value.period),
      sample: stringValue(value.sample),
      method: stringValue(value.method),
      caveat: stringValue(value.caveat),
      sentence: stringValue(value.sentence),
      sourceText: stringValue(value.sourceText),
      ...(numberValue(value.evidenceIndex) !== undefined ? { evidenceIndex: numberValue(value.evidenceIndex) } : {}),
      ...(Array.isArray(value.imageUrls) ? { imageUrls: value.imageUrls.filter((url): url is string => typeof url === "string") } : {})
    };
    // 같은 값이 다른 시점·다른 비교 대상으로 보고되면 서로 다른 주장이다.
    // 차트는 한 값(+84.3%)을 여러 시점에 인쇄하므로, 지문에 시점과 비교 대상이
    // 없으면 뒤에 온 시점의 주장이 중복으로 버려진다.
    const key = normalizeFingerprint([
      claim.label,
      claim.subject,
      claim.value,
      claim.metric,
      claim.timing,
      claim.comparator,
      claim.sentence,
      claim.sourceText
    ].filter(Boolean).join(" "));
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [claim];
  });
}

function uniqueSemanticIngredientBenefitLinks(values: GeoSemanticIngredientBenefitLink[]): GeoSemanticIngredientBenefitLink[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const link: GeoSemanticIngredientBenefitLink = {
      ingredient: stringValue(value.ingredient),
      benefit: stringValue(value.benefit),
      effect: stringValue(value.effect),
      sentence: stringValue(value.sentence),
      sourceText: stringValue(value.sourceText),
      ...(numberValue(value.evidenceIndex) !== undefined ? { evidenceIndex: numberValue(value.evidenceIndex) } : {}),
      ...(Array.isArray(value.imageUrls) ? { imageUrls: value.imageUrls.filter((url): url is string => typeof url === "string") } : {})
    };
    const key = normalizeFingerprint([
      link.ingredient,
      link.benefit,
      link.effect,
      link.sentence,
      link.sourceText
    ].filter(Boolean).join(" "));
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [link];
  });
}

/** 피부 타입을 가리키는 수식어. 두 언어에서 같은 집합을 가리킨다. */
const SKIN_TYPE_MODIFIER_EN = "dry|sensitive|oily|combination|normal";
const SKIN_TYPE_MODIFIER_KO = "건조|건성|민감|지성|복합성|중성";

/**
 * 원문이 밝힌 피부 타입을 뽑는다.
 *
 * 두 언어가 등위를 다르게 쓴다. 한국어는 머리 명사를 되풀이하고("건조 피부 또는
 * 민감 피부"), 영문은 마지막에 한 번만 쓴다("Dry or sensitive skin"). 되풀이를
 * 전제한 규칙으로 영문을 읽으면 앞의 타입이 통째로 빠진다 — 미국 대상 페이지에서
 * `dry skin`이 사라지고 `sensitive skin`만 남았다.
 *
 * 그래서 수식어의 등위를 먼저 읽고, 각 수식어에 머리 명사를 붙여 같은 형태로
 * 돌려준다.
 */
function extractSkinTypeSignals(value: string): string[] {
  const text = cleanText(value);
  const englishGroups = text.match(
    new RegExp(`(?:${SKIN_TYPE_MODIFIER_EN})(?:\\s*(?:,|/|or|and)\\s*(?:${SKIN_TYPE_MODIFIER_EN}))*\\s+skin`, "gi")
  ) ?? [];
  const koreanGroups = text.match(
    new RegExp(`(?:${SKIN_TYPE_MODIFIER_KO})(?:\\s*(?:,|/|또는|과|와|이나)\\s*(?:${SKIN_TYPE_MODIFIER_KO}))*\\s*피부`, "g")
  ) ?? [];

  return unique([
    ...englishGroups.flatMap((group) =>
      (group.match(new RegExp(SKIN_TYPE_MODIFIER_EN, "gi")) ?? []).map((modifier) => `${modifier.toLowerCase()} skin`)),
    ...koreanGroups.flatMap((group) =>
      (group.match(new RegExp(SKIN_TYPE_MODIFIER_KO, "g")) ?? []).map((modifier) => `${modifier} 피부`))
  ]);
}

function hasMetricSignal(value: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:%|배)|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|명|주|일|시간)\b/i.test(value);
}

function hasBenefitOrEffectLanguage(value: string): boolean {
  return /benefit|effect|support|help|improve|care|hydration|moisture|barrier|firm|elastic|texture|효능|효과|개선|케어|보습|수분|장벽|탄력|피부결/i.test(value);
}

function toGeoSentenceInsights(items: OcrExtraction["extractedTexts"]): GeoSentenceInsight[] {
  return uniqueGeoSentenceInsights(items.flatMap((item) =>
    item.sentenceInsights.map((insight) => ({
      imageUrl: insight.imageUrls?.[0] ?? item.imageUrl,
      imageUrls: insight.imageUrls ?? item.imageUrls ?? [item.imageUrl],
      text: insight.text,
      category: insight.category,
      keywords: insight.keywords,
      semanticFacts: insight.semanticFacts
    }))
  )).slice(0, OCR_EVIDENCE_LIMIT);
}

function uniqueGeoSentenceInsights(insights: GeoSentenceInsight[]): GeoSentenceInsight[] {
  const seen = new Set<string>();
  return insights.filter((insight) => {
    const key = `${insight.category}:${normalizeFingerprint(insight.text).slice(0, 160)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return insight.text.length > 0;
  });
}

async function createKeywordClassificationRequest(
  source: string,
  productName: string,
  imageTexts: OcrTextCandidate[],
  options: ProductExtractorOptions,
  runtimeSteps?: RuntimePipelineStep[]
) {
  const query = createProductExtractorRagQuery({
    source,
    productName,
    imageTexts
  });
  const ragDocuments = retrieveProductExtractorRagDocuments({
    query,
    documents: options.ragDocuments ?? [],
    settings: options.rag,
    embedding: options.embedding,
    reranker: options.reranker,
    onRuntimeStep: runtimeSteps ? (step) => runtimeSteps.push(step) : undefined
  });

  return {
    source,
    productName,
    imageTexts,
    analysisPrompt: options.analysisPrompt,
    ragDocuments: await ragDocuments
  };
}

function collectImageTextCandidates($: ReturnType<typeof load>, source: string): OcrTextCandidate[] {
  return $("img, picture source")
    .toArray()
    .map((node, index) => {
      const element = $(node);
      const imageUrl = imageUrlFromNode($, node, source) ?? `${source}#visual-${index + 1}`;
      const text = normalizeOcrText([
        element.attr("data-ocr-text"),
        element.attr("data-recognized-text"),
        element.attr("data-extracted-text"),
        element.attr("data-full-text")
      ].filter(Boolean).join("\n"));
      return { imageUrl, text };
    })
    .filter((item) => item.text.length >= 12 && scoreProductText(item.text, "") > 0 && isProductEvidenceCandidate("", item.text));
}

function collectImageOcrTargets($: ReturnType<typeof load>, source: string, imageUrls: string[] = [], productName = ""): string[] {
  const domCandidates = $("img, picture source")
    .toArray()
    .flatMap((node, sourceOrder): ImageOcrTargetCandidate[] => {
      const element = $(node);
      const context = imageOcrEvidenceContext($, node);
      const label = cleanText([
        ...imageUrlsFromNode($, node, source),
        element.attr("alt"),
        element.attr("title"),
        element.attr("aria-label"),
        context.text,
        textAroundImage($, node)
      ].filter(Boolean).join(" "));
      const score = scoreImageOcrTarget(label, context, productName);

      if (!shouldUseContextualImageOcrTarget(label, context, score, productName)) {
        return [];
      }

      return imageUrlsFromNode($, node, source).map((imageUrl): ImageOcrTargetCandidate => ({
        imageUrl,
        score,
        sourceOrder,
        sectionKey: context.sectionKey
      }));
    });

  const contextualCandidates = domCandidates
    .filter((item) => isHttpSupportedOcrImageUrl(item.imageUrl));
  const rawContextCandidates = collectRawImageOcrTargetCandidates($.html() ?? "", source, productName, 50_000)
    .filter((item) => isHttpSupportedOcrImageUrl(item.imageUrl));
  const explicitCandidates = imageUrls.map((imageUrl, index): ImageOcrTargetCandidate => ({
    imageUrl,
    score: scoreImageOcrTarget(imageUrl, undefined, productName),
    sourceOrder: 100_000 + index,
    sectionKey: "explicit"
  })).filter((item) => isHttpSupportedOcrImageUrl(item.imageUrl));
  const contentCandidates = [...contextualCandidates, ...rawContextCandidates];
  const candidates = contentCandidates.length > 0
    ? contentCandidates
    : explicitCandidates.slice(0, MAX_SCRIPT_ONLY_IMAGE_OCR_TARGETS);

  return selectImageOcrTargets(candidates);
}

function shouldUseContextualImageOcrTarget(label: string, context: ImageOcrContext, score: number, productName: string): boolean {
  if (isCommerceImageOcrContext(context.text)) {
    return false;
  }
  if (context.hasNegativeSection && !context.hasProductEvidenceSection) {
    return false;
  }
  if (hasConflictingProductType(label, productName)) {
    return false;
  }
  if (isGalleryLikeOcrContext(context.text) && !isHighValueOcrEvidenceContext(context.text) && !hasProductNameSignal(label, productName)) {
    return false;
  }
  if (context.hasProductEvidenceSection && score > 0) {
    return true;
  }
  return score >= MIN_CONTEXTUAL_IMAGE_OCR_SCORE && !isNegativeOcrSectionText(label);
}

function selectImageOcrTargets(candidates: ImageOcrTargetCandidate[]): string[] {
  const bestByImage = new Map<string, ImageOcrTargetCandidate>();

  for (const candidate of candidates) {
    const key = canonicalOcrImageKey(candidate.imageUrl);
    const current = bestByImage.get(key);
    const candidateWidth = imageVariantWidth(candidate.imageUrl);
    const currentWidth = current ? imageVariantWidth(current.imageUrl) : 0;
    if (
      !current
      || candidateWidth > currentWidth
      || (candidateWidth === currentWidth && candidate.score > current.score)
      || (candidateWidth === currentWidth && candidate.score === current.score && candidate.sourceOrder < current.sourceOrder)
    ) {
      bestByImage.set(key, candidate);
    }
  }

  return Array.from(bestByImage.values())
    .sort((a, b) => b.score - a.score || a.sourceOrder - b.sourceOrder)
    .slice(0, MAX_IMAGE_OCR_TARGETS)
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .map((item) => item.imageUrl);
}

function isHttpSupportedOcrImageUrl(imageUrl: string): boolean {
  return typeof imageUrl === "string"
    && /^https?:\/\//i.test(imageUrl)
    && isSupportedOcrImageUrl(imageUrl)
    && !isLikelyTinyOcrImage(imageUrl);
}

function isLikelyTinyOcrImage(imageUrl: string): boolean {
  const width = imageVariantWidth(imageUrl);
  return width > 0 && width < 160;
}

function scoreImageOcrTarget(value: string, context?: ImageOcrContext, productName = ""): number {
  const text = value.toLowerCase();
  if (isReviewImageUrl(text)) {
    return -100;
  }
  const negativePenalty = context?.hasNegativeSection && !context.hasProductEvidenceSection ? -40 : 0;
  const productEvidenceSection = context?.hasProductEvidenceSection ? 18 : 0;
  const productNameBoost = hasProductNameSignal(value, productName) ? 10 : 0;
  const productConflictPenalty = hasConflictingProductType(value, productName) ? -60 : 0;
  const strongSignals = [
    /clinical|result|before|after|infographic|ingredient|benefit|efficacy|survey|study/,
    /wrinkle|firm|elastic|texture|radiance|ginseng|retinol|peptide|niacinamide/,
    /use|how-to-use|how\s*to\s*use|routine|ritual|apply|direction/,
    /효능|효과|성분|전성분|원료|보습|수분|장벽|피지|유분|사용법|임상|결과/
  ].filter((pattern) => pattern.test(text)).length * 8;
  const productImageSignals = [
    /\/upload\/product\//,
    /dspimg|detail|pdp|prd|product|goods|contents|visual|main|description|technology|tech|ingredient|formula|spec/,
    /상세|기술|기술서|성분|효능|효과|제품\s*정보|상품\s*정보/,
    /serum|cream|크림|세럼|앰플|토너/
  ].filter((pattern) => pattern.test(text)).length * 12;
  const weakSignals = /(product|detail|pdp|brand\.com|serum|cream|description|technology|ingredient|spec|상품|상세|기술|성분|효능|효과)/i.test(value) ? 3 : 0;
  return productEvidenceSection + productNameBoost + strongSignals + productImageSignals + weakSignals + negativePenalty + productConflictPenalty;
}

/**
 * Re-transcribes the dense inputs of a batch and keeps only what both readings
 * agree on. See `reconcileOcrReadings` for why one reading is not checkable.
 *
 * Only sliced inputs are re-read. Slicing is the pipeline's own signal that an
 * image carries small, dense text, which is where transcription invents words;
 * a product shot whose whole text is a label on a bottle does not need a second
 * opinion and would double its cost for nothing.
 */
async function verifyOcrBatchReadings(input: {
  classifier: KeywordClassifier;
  source: string;
  productName?: string;
  batch: ImageOcrInput[];
  firstReading: Array<{
    imageUrl: string;
    displayUrl: string;
    text: string;
    confidence?: number;
    groups?: OcrLayoutGroup[];
    sliceIndex?: number;
    sliceCount?: number;
  }>;
  collector?: OcrDiagnosticsCollector;
  runtimeSteps: RuntimePipelineStep[];
  options: ProductExtractorOptions;
  onProgress?: (message: string) => void;
}): Promise<OcrTextCandidate[]> {
  const asCandidates = () => input.firstReading.map(({ imageUrl, text, confidence, groups, sliceIndex, sliceCount }) => ({
    imageUrl,
    text,
    confidence,
    ...(groups ? { groups } : {}),
    ...(sliceIndex !== undefined ? { sliceIndex } : {}),
    ...(sliceCount !== undefined ? { sliceCount } : {})
  }));
  const denseInputs = input.batch.filter(isSliceOrInlineImageOcrInput);
  if (!input.classifier.extractImageTexts || denseInputs.length === 0) {
    return asCandidates();
  }

  let verification: ImageTextExtractionResponse;
  try {
    input.onProgress?.(`밀집 텍스트 이미지 ${denseInputs.length}개를 2차 판독해 두 판독이 일치하는 텍스트만 남깁니다.`);
    verification = await input.classifier.extractImageTexts({
      source: input.source,
      productName: input.productName,
      imageUrls: denseInputs.map((item) => item.displayUrl),
      imageInputs: denseInputs
    });
    input.runtimeSteps.push(createModelRuntimeStep(
      "ocr",
      "OCR verification reading",
      input.options,
      "ocr",
      verification.usage,
      `${denseInputs.length} dense product-detail image input(s) re-transcribed so only text both readings agree on is kept.`
    ));
  } catch (error) {
    // A failed second opinion must not discard the first reading: the pipeline
    // is no worse off than before verification existed.
    const message = error instanceof Error ? error.message : "Image OCR verification failed.";
    input.onProgress?.(`2차 판독이 실패해 1차 판독 결과를 그대로 사용합니다: ${message}`);
    return asCandidates();
  }

  const verificationByUrl = new Map(verification.images.map((image): [string, string] => [image.imageUrl, normalizeOcrText(image.text)]));
  return input.firstReading.flatMap((item): OcrTextCandidate[] => {
    const sliceFields = {
      // 구조는 1차 판독의 산물이다. 대조가 텍스트를 좁혀도 그대로 실어 보내고,
      // 어긋난 라인은 검증(verifyOcrLayoutGroups)이 최종 텍스트 기준으로 걸러낸다.
      ...(item.groups ? { groups: item.groups } : {}),
      ...(item.sliceIndex !== undefined ? { sliceIndex: item.sliceIndex } : {}),
      ...(item.sliceCount !== undefined ? { sliceCount: item.sliceCount } : {})
    };
    const second = verificationByUrl.get(item.displayUrl);
    if (!second) {
      return [{ imageUrl: item.imageUrl, text: item.text, confidence: item.confidence, ...sliceFields }];
    }
    const { text, droppedTokens } = reconcileOcrReadings(item.text, second);
    if (droppedTokens.length > 0 && input.collector) {
      const targetDiagnostic = ocrTargetDiagnostic(input.collector, item.imageUrl);
      targetDiagnostic.issues.push(
        `${droppedTokens.length} token(s) differed between two readings and were dropped as unverified: ${unique(droppedTokens).slice(0, 6).join(", ")}`
      );
    }
    return text.length >= 8 ? [{ imageUrl: item.imageUrl, text, confidence: item.confidence, ...sliceFields }] : [];
  });
}

/**
 * Reconciles two independent transcriptions of the same image, keeping only
 * what both readings agree on.
 *
 * A single transcription cannot be checked against anything. The EXAMPLEDERMA
 * 크림 미스트 detail image reads "대학병원 피부과에서"; one reading returned
 * "휘경보건 피부과에서" and reported 0.91 confidence, so a clinic that does not
 * exist entered the pipeline as a fact. Confidence is the model's own opinion
 * of a reading, and it was wrong about this one.
 *
 * Two readings disagree exactly where one of them invented something. Aligning
 * them and keeping the agreed tokens turns an invented proper noun into an
 * absent one, which is the failure mode this pipeline can afford: a missing
 * institution costs a provenance detail, while a fabricated one publishes a
 * false statement about a real third party.
 *
 * Agreement is computed over tokens rather than whole strings because the two
 * readings differ in harmless ways too — spacing, line breaks, a trailing
 * marker — and discarding a whole block over those would lose real text.
 */
export function reconcileOcrReadings(first: string, second: string): { text: string; droppedTokens: string[] } {
  const firstTokens = first.split(/(\s+)/u);
  const secondTokens = second.split(/\s+/u).filter(Boolean).map(normalizeOcrComparisonText);
  // Reconciliation only means anything when the two readings are readings of
  // the same thing. When they diverge broadly — a slice boundary landed
  // differently, one pass skipped a column — intersecting their tokens shreds
  // both into a text neither reported. The first reading is then kept whole:
  // this guard exists to remove invented words, not to assemble a third
  // version out of two disagreeing ones.
  // The ratio only carries information once there is enough text to measure:
  // over a handful of tokens a single legitimate difference already looks like
  // a different reading.
  const contentTokenCount = firstTokens.filter((token) => !/^\s*$/u.test(token)).length;
  if (contentTokenCount >= 12 && agreementRatio(firstTokens, secondTokens) < 0.8) {
    return { text: normalizeOcrText(first), droppedTokens: [] };
  }
  const secondCounts = new Map<string, number>();
  for (const token of secondTokens) {
    secondCounts.set(token, (secondCounts.get(token) ?? 0) + 1);
  }
  const droppedTokens: string[] = [];
  const kept = firstTokens.map((token) => {
    if (/^\s*$/u.test(token)) return token;
    const key = normalizeOcrComparisonText(token);
    const remaining = secondCounts.get(key) ?? 0;
    if (remaining > 0) {
      secondCounts.set(key, remaining - 1);
      return token;
    }
    droppedTokens.push(token);
    return "";
  });
  return {
    text: normalizeOcrText(kept.join("").replace(/[ \t]{2,}/gu, " ")),
    droppedTokens
  };
}

/** Share of the first reading's tokens that the second reading also reports. */
function agreementRatio(firstTokens: string[], secondTokens: string[]): number {
  const available = new Map<string, number>();
  for (const token of secondTokens) {
    available.set(token, (available.get(token) ?? 0) + 1);
  }
  let total = 0;
  let matched = 0;
  for (const token of firstTokens) {
    if (/^\s*$/u.test(token)) continue;
    total += 1;
    const key = normalizeOcrComparisonText(token);
    const remaining = available.get(key) ?? 0;
    if (remaining > 0) {
      available.set(key, remaining - 1);
      matched += 1;
    }
  }
  return total === 0 ? 1 : matched / total;
}

/**
 * Re-joins tall-image slice transcriptions in their known slice order before
 * the general merge. Overlap-aware joining is tried first; when the model
 * transcribed the overlap band differently the slices are still concatenated
 * in order instead of silently staying apart (the pre-fix failure mode).
 */
export function joinSliceCandidates(candidates: OcrTextCandidate[], stats?: OcrMergeStats): OcrTextCandidate[] {
  const groups = new Map<string, OcrTextCandidate[]>();
  const groupPositions = new Map<string, number>();
  const passthrough: Array<{ candidate: OcrTextCandidate; position: number }> = [];

  candidates.forEach((candidate, position) => {
    if (candidate.sliceIndex === undefined) {
      passthrough.push({ candidate, position });
      return;
    }
    const group = groups.get(candidate.imageUrl) ?? [];
    group.push(candidate);
    groups.set(candidate.imageUrl, group);
    if (!groupPositions.has(candidate.imageUrl)) {
      groupPositions.set(candidate.imageUrl, position);
    }
  });

  const joined: Array<{ candidate: OcrTextCandidate; position: number }> = [...passthrough];

  for (const [imageUrl, group] of groups) {
    const ordered = [...group].sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0));
    const first = ordered[0];
    if (!first) {
      continue;
    }
    // 구조는 슬라이스 단위로 왔으므로, 텍스트를 잇는 동안 각 슬라이스가 선두에서
    // 몇 줄을 내놓았는지(=앞 슬라이스가 소유한 줄)를 함께 모아 둔다.
    const readings: SlicedLayoutReading[] = [{
      sliceIndex: first.sliceIndex ?? 1,
      ...(first.groups ? { groups: first.groups } : {})
    }];
    const merged = ordered.slice(1).reduce<OcrTextCandidate>((acc, slice) => {
      const overlapResult = joinOverlappingOcrTextsResult(acc.text, slice.text, { tolerateDroppedTokens: true });
      const overlapJoined = overlapResult.joined ? overlapResult : undefined;
      if (overlapJoined !== undefined && stats) {
        stats.overlapJoins += 1;
      }
      if (!overlapResult.joined && stats) {
        const tailLines = acc.text.split("\n");
        const headLines = slice.text.split("\n");
        stats.unmatchedBoundaries.push({
          imageUrl,
          sliceIndex: slice.sliceIndex ?? readings.length + 1,
          tailPreview: tailLines.slice(-3).join(" ⏎ ").slice(-160),
          headPreview: headLines.slice(0, 3).join(" ⏎ ").slice(0, 160)
        });
      }
      readings.push({
        sliceIndex: slice.sliceIndex ?? readings.length + 1,
        ...(slice.groups ? { groups: slice.groups } : {}),
        ...(overlapResult.joined
          ? { consumedLines: overlapResult.consumedLines }
          : { overlapUnmatched: true })
      });
      return {
        ...acc,
        text: overlapJoined?.text ?? `${acc.text}\n${slice.text}`,
        confidence: minDefinedConfidence(acc.confidence, slice.confidence)
      };
    }, first);
    const stitchedGroups = stitchSlicedLayoutGroups(readings);
    if (stats) {
      const reportedGroups = readings.reduce((sum, reading) => sum + (reading.groups?.length ?? 0), 0);
      if (stitchedGroups) {
        // 재기점 뒤 남은 그룹 수가 보고된 수보다 적으면 그만큼 경계에서 합쳐졌거나
        // 오버랩 소유권으로 빠진 것이다.
        stats.layoutSliceStitches += Math.max(0, reportedGroups - stitchedGroups.length);
      } else if (reportedGroups > 0) {
        stats.layoutDiscarded.push({
          imageUrl,
          reason: readings.some((reading) => reading.overlapUnmatched) ? "overlap-unmatched" : "slice-partial"
        });
      }
    }
    joined.push({
      candidate: {
        imageUrl,
        text: merged.text,
        ...(merged.confidence !== undefined ? { confidence: merged.confidence } : {}),
        imageUrls: [imageUrl],
        ...(stitchedGroups ? { groups: stitchedGroups } : {}),
        ...(first.sliceCount !== undefined ? { sliceCount: first.sliceCount } : {}),
        ...(first.sourceOrder !== undefined ? { sourceOrder: first.sourceOrder } : {})
      },
      position: groupPositions.get(imageUrl) ?? 0
    });
  }

  return joined.sort((a, b) => a.position - b.position).map((item) => item.candidate);
}

/**
 * Merges OCR text candidates with overlap awareness. Exact and contained
 * duplicates collapse onto the longer text, and candidates whose boundary
 * lines overlap (sliced tall images, adjacent srcset variants) are joined so
 * sentences crossing a slice boundary survive with the duplication removed.
 */
export function mergeOcrCandidates(
  candidates: OcrTextCandidate[],
  stats?: OcrMergeStats,
  limit?: number
): OcrTextCandidate[] {
  const merged: Array<OcrTextCandidate & { fingerprint: string; order: number }> = [];

  candidates.forEach((candidate, index) => {
    const text = normalizeOcrText(candidate.text);

    if (text.length === 0) {
      return;
    }

    const fingerprint = normalizeOcrComparisonText(text);
    const candidateImageUrls = candidate.imageUrls ?? [candidate.imageUrl];
    let absorbed = false;

    for (const [position, existing] of merged.entries()) {
      const unionImageUrls = unique([...(existing.imageUrls ?? [existing.imageUrl]), ...candidateImageUrls]);
      if (existing.fingerprint === fingerprint || existing.fingerprint.includes(fingerprint)) {
        existing.confidence = minDefinedConfidence(existing.confidence, candidate.confidence);
        existing.imageUrls = unionImageUrls;
        existing.sliceIndex = undefined;
        existing.sliceCount = mergedSliceCount(existing, candidate);
        if (stats) {
          stats.duplicatesAbsorbed += 1;
        }
        absorbed = true;
        break;
      }
      if (fingerprint.includes(existing.fingerprint)) {
        merged[position] = {
          ...existing,
          text,
          confidence: minDefinedConfidence(existing.confidence, candidate.confidence),
          imageUrls: unionImageUrls,
          sliceIndex: undefined,
          sliceCount: mergedSliceCount(existing, candidate),
          fingerprint
        };
        if (stats) {
          stats.duplicatesAbsorbed += 1;
        }
        absorbed = true;
        break;
      }

      const joined = joinOverlappingOcrTexts(existing.text, text) ?? joinOverlappingOcrTexts(text, existing.text);
      // (서로 다른 후보의 병합이므로 관용 매칭을 쓰지 않는다.)
      if (joined) {
        merged[position] = {
          ...existing,
          text: joined.text,
          confidence: minDefinedConfidence(existing.confidence, candidate.confidence),
          imageUrls: unionImageUrls,
          sliceIndex: undefined,
          sliceCount: mergedSliceCount(existing, candidate),
          fingerprint: normalizeOcrComparisonText(joined.text),
          // 서로 다른 이미지(srcset 변형 등)의 텍스트를 이은 결과에는 어느 쪽
          // 구조도 그대로 맞지 않는다. 구조를 버려 줄 파서로 되돌린다.
          groups: undefined
        };
        if (stats) {
          stats.overlapJoins += 1;
        }
        absorbed = true;
        break;
      }
    }

    if (!absorbed) {
      merged.push({
        ...candidate,
        text,
        imageUrls: candidateImageUrls,
        fingerprint,
        order: index
      });
    }
  });

  // 점수는 근거 상한 선별에만 쓰고, 반환은 페이지 읽기 순서를 유지한다 —
  // 분류 프롬프트가 이미지 간 문맥 연속성(헤딩→본문)을 보게 하기 위함.
  const selected = [...merged]
    .sort((a, b) => scoreProductText(b.text, "") - scoreProductText(a.text, "") || b.text.length - a.text.length)
    .slice(0, limit ?? merged.length);

  return selected
    .sort((a, b) => (a.sourceOrder ?? a.order) - (b.sourceOrder ?? b.order))
    .map(({ fingerprint: _fingerprint, order: _order, confidence, ...candidate }) => ({
      ...candidate,
      ...(confidence !== undefined ? { confidence } : {})
    }));
}

/**
 * A merged/joined entry no longer describes a single tall-image slice, so its
 * sliceIndex is always cleared by the caller. sliceCount (the total slice
 * count) only stays meaningful when both sides came from the same source
 * image; across different images it is cleared too.
 */
function mergedSliceCount(
  existing: { imageUrl: string; sliceCount?: number },
  candidate: { imageUrl: string; sliceCount?: number }
): number | undefined {
  return existing.imageUrl === candidate.imageUrl ? existing.sliceCount : undefined;
}

function minDefinedConfidence(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

/** 겹침 조인 결과. 이어붙였다면 뒤 판독에서 걷어낸 줄까지 함께 돌려준다. */
type OcrOverlapJoin =
  | { joined: true; text: string; consumedLines: string[] }
  | { joined: false };

/**
 * 앞 판독의 끝줄이 뒤 판독의 첫줄로 되풀이될 때 둘을 하나로 잇는다. 한 시각
 * 블록이 겹치는 두 슬라이스에 걸쳐 잡힐 때 일어난다.
 *
 * 뒤 판독의 선두에서 걷어낸 줄도 함께 돌려준다. 그 줄들이 슬라이스 구조의
 * 소유권 경계다 — 걷어낸 줄은 앞 슬라이스가 소유하므로, 뒤 슬라이스 구조에서
 * 같은 줄을 다시 세면 그 항목이 두 번 발행된다.
 *
 * 겹침은 의미 있는 길이여야 한다. 문턱은 {@link distinctiveOverlapLength}가
 * 문자 체계별로 정한다 — 한글은 음절 하나가 라틴 두세 글자만큼의 정보를 담으므로
 * 같은 문턱을 쓰면 정상 겹침이 비교조차 되지 않는다.
 */
function joinOverlappingOcrTextsResult(
  first: string,
  second: string,
  options: { tolerateDroppedTokens?: boolean } = {}
): OcrOverlapJoin {
  const firstLines = first.split("\n");
  const secondLines = second.split("\n");
  const maxOverlapLines = Math.min(12, firstLines.length, secondLines.length);

  for (let overlap = maxOverlapLines; overlap >= 1; overlap -= 1) {
    const tail = firstLines.slice(-overlap).join("\n");
    const head = secondLines.slice(0, overlap).join("\n");
    const tailFingerprint = normalizeOcrComparisonText(tail);

    if (tailFingerprint.length < distinctiveOverlapLength(tailFingerprint)) {
      continue;
    }
    // 토큰 손실을 감안한 매칭은 **같은 이미지의 인접 슬라이스**에서만 쓴다.
    // 서로 다른 이미지(srcset 변형 등)에까지 허용하면 비슷한 문구를 가진 상세
    // 이미지들이 한 후보로 합쳐진다 — 실제로 24장이 1장으로 붕괴했다.
    const agrees = tailFingerprint === normalizeOcrComparisonText(head)
      || (options.tolerateDroppedTokens === true
        && overlapReadingsAgree(firstLines.slice(-overlap), secondLines.slice(0, overlap)));
    if (agrees) {
      return {
        joined: true,
        text: [...firstLines, ...secondLines.slice(overlap)].join("\n"),
        consumedLines: secondLines.slice(0, overlap)
      };
    }
  }

  return { joined: false };
}

/** 텍스트만 필요한 호출부를 위한 래퍼. */
/** 조인 성공만 알면 되는 호출부를 위한 형태. */
function joinOverlappingOcrTexts(
  first: string,
  second: string
): { text: string; consumedLines: string[] } | undefined {
  const result = joinOverlappingOcrTextsResult(first, second);
  return result.joined ? { text: result.text, consumedLines: result.consumedLines } : undefined;
}

/**
 * 같은 구간이라고 볼 만한 겹침의 최소 길이. 문자 체계마다 다르다.
 *
 * 한글은 음절 하나가 라틴 두세 글자만큼의 정보를 담는다. 문자 수 문턱 하나로
 * 재면 한국어 겹침이 부당하게 짧다고 판정된다 — 1027 실측에서 슬라이스 3의
 * 겹침은 `• 부드럽게 뿌려져 피부 표면에 보습막을 형성` 한 줄(정규화 18자)이
 * 었는데, 20자 문턱에 걸려 비교조차 되지 않았다. 그 결과 겹친 줄이 두 번 남고
 * 구조 전체가 폐기됐다.
 */
function distinctiveOverlapLength(fingerprint: string): number {
  const hangul = (fingerprint.match(/[가-힣]/gu) ?? []).length;
  return hangul * 2 >= fingerprint.length ? 10 : 20;
}

/**
 * 두 겹침 구간이 같은 이미지 행을 옮긴 것인지, 한쪽에서 토큰이 빠진 관계로 본다.
 *
 * 겹침 조인은 2회 판독 대조 뒤에 일어난다. 대조는 두 판독이 불일치한 토큰을
 * 슬라이스마다 독립적으로 덜어내므로, 같은 행을 옮긴 두 겹침이 정확히 같지
 * 않게 된다 — 1027 실측(7슬라이스)에서 경계 6개 중 4개가 그렇게 어긋나
 * 이어지지 못했고, 겹친 행이 두 번 남고 구조 전체가 폐기됐다.
 *
 * 대조는 토큰을 덜어내기만 하므로 한쪽은 다른 쪽의 부분열이다. 그 관계로
 * 맞춘다 — 서로 다른 구간이 우연히 부분열이 되는 것을 막기 위해, 짧은 쪽이
 * 세 토큰 이상이고 그 대부분(4/5 이상)이 긴 쪽에 순서대로 나타날 때만 같은
 * 구간으로 읽는다.
 */
function overlapReadingsAgree(tailLines: string[], headLines: string[]): boolean {
  if (tailLines.length !== headLines.length || tailLines.length === 0) {
    return false;
  }
  // 줄끼리 짝지어 맞춘다. 블록 전체를 한 덩어리로 비교하면 실제로는 한 줄만
  // 겹치는 경계에서도 여러 줄이 우연히 부분열을 이뤄, 뒤 슬라이스의 줄을
  // 과하게 소비한다.
  const agreements = tailLines.map((line, index) => lineReadingsAgree(line, headLines[index] ?? ""));
  return agreements.every((agreement) => agreement.agrees)
    && agreements.some((agreement) => agreement.tokens >= 3);
}

function lineReadingsAgree(tail: string, head: string): { agrees: boolean; tokens: number } {
  const tokenize = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tailTokens = tokenize(tail);
  const headTokens = tokenize(head);
  const [shorter, longer] = tailTokens.length <= headTokens.length
    ? [tailTokens, headTokens]
    : [headTokens, tailTokens];

  if (shorter.length < 2) {
    return { agrees: shorter.length === longer.length && shorter.every((token, index) => token === longer[index]), tokens: shorter.length };
  }

  let cursor = 0;
  let matched = 0;
  for (const token of shorter) {
    const found = longer.indexOf(token, cursor);
    if (found >= 0) {
      cursor = found + 1;
      matched += 1;
    }
  }

  return { agrees: matched / shorter.length >= 0.8, tokens: shorter.length };
}

function imageUrlFromNode($: ReturnType<typeof load>, node: CheerioInput, source: string): string | undefined {
  return imageUrlsFromNode($, node, source)[0];
}

function imageUrlsFromNode($: ReturnType<typeof load>, node: CheerioInput, source: string): string[] {
  const element = $(node);
  return unique([
    element.attr("src") ??
      element.attr("data-src") ??
      element.attr("data-original") ??
      element.attr("data-zoom"),
    element.attr("data-src"),
    element.attr("data-original"),
    element.attr("data-lazy-src"),
    element.attr("data-zoom"),
    element.attr("data-image"),
    element.attr("data-url"),
    element.attr("data-mobile-src"),
    element.attr("data-pc-src"),
    element.attr("data-desktop-src"),
    ...srcsetUrls(element.attr("srcset")),
    ...srcsetUrls(element.attr("data-srcset"))
  ].map((value) => absoluteUrl(value, source)).filter((value): value is string => Boolean(value)));
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcsetUrls(srcset)[0];
}

function srcsetUrls(srcset: string | undefined): string[] {
  return srcset?.split(",").map((item) => item.trim().split(/\s+/)[0]).filter((value): value is string => Boolean(value)) ?? [];
}

function extractRawImageUrls(value: string, source: string): string[] {
  return unique(extractRawImageUrlMatches(value, source)
    .map((match) => match.imageUrl)
    .filter((imageUrl) => /^https?:\/\//i.test(imageUrl) && isSupportedOcrImageUrl(imageUrl)));
}

interface RawImageUrlMatch {
  imageUrl: string;
  context: string;
  sourceOrder: number;
}

function collectRawImageOcrTargetCandidates(value: string, source: string, productName: string, sourceOrderOffset: number): ImageOcrTargetCandidate[] {
  return extractRawImageUrlMatches(value, source).flatMap((match, index): ImageOcrTargetCandidate[] => {
    if (!isHttpSupportedOcrImageUrl(match.imageUrl)) {
      return [];
    }

    const context = imageOcrContextFromText(match.context, `raw-${index + 1}`);
    const label = cleanText([match.imageUrl, context.text].filter(Boolean).join(" "));
    const score = scoreImageOcrTarget(label, context, productName);

    if (!shouldUseContextualImageOcrTarget(label, context, score, productName)) {
      return [];
    }

    return [{
      imageUrl: match.imageUrl,
      score,
      sourceOrder: sourceOrderOffset + match.sourceOrder,
      sectionKey: context.sectionKey
    }];
  });
}

function extractRawImageUrlMatches(value: string, source: string): RawImageUrlMatch[] {
  const matches: RawImageUrlMatch[] = [];
  const rawUrlPattern = /(?:https?:)?\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi;
  const relativeUrlPattern = /(?:^|[\s"'(=])((?:\/|\.{1,2}\/)[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?)/gi;

  for (const match of value.matchAll(rawUrlPattern)) {
    matches.push({
      imageUrl: normalizeRawImageUrl(match[0], source),
      context: rawImageUrlContext(value, match.index ?? 0, match[0].length),
      sourceOrder: match.index ?? 0
    });
  }

  for (const match of value.matchAll(relativeUrlPattern)) {
    const rawValue = match[1] ?? "";
    const rawIndex = (match.index ?? 0) + (match[0].lastIndexOf(rawValue) >= 0 ? match[0].lastIndexOf(rawValue) : 0);
    matches.push({
      imageUrl: normalizeRawImageUrl(rawValue, source),
      context: rawImageUrlContext(value, rawIndex, rawValue.length),
      sourceOrder: rawIndex
    });
  }

  return uniqueRawImageUrlMatches(matches.filter((match) => match.imageUrl.length > 0 && isSupportedOcrImageUrl(match.imageUrl)));
}

function rawImageUrlContext(value: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - RAW_IMAGE_CONTEXT_RADIUS);
  const end = Math.min(value.length, matchIndex + matchLength + RAW_IMAGE_CONTEXT_RADIUS);
  return value.slice(start, end);
}

function uniqueRawImageUrlMatches(matches: RawImageUrlMatch[]): RawImageUrlMatch[] {
  const seen = new Set<string>();
  const result: RawImageUrlMatch[] = [];

  for (const match of matches) {
    const key = `${match.imageUrl}:${normalizeFingerprint(match.context).slice(0, 120)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(match);
  }

  return result;
}

function normalizeRawImageUrl(value: string, source: string): string {
  const trimmed = value.trim().replace(/&amp;/g, "&").replace(/[.,;:]+$/g, "");
  const protocolSafe = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  return absoluteUrl(protocolSafe, source) ?? protocolSafe;
}

function isSupportedOcrImageUrl(imageUrl: string): boolean {
  const urlPath = imageUrl.split(/[?#]/)[0] ?? imageUrl;
  if (isReviewImageUrl(imageUrl) || /\.(?:svg|gif)(?:[?#]|$)/i.test(imageUrl) || /\.$/.test(urlPath)) {
    return false;
  }
  return /\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(imageUrl)
    || /\/upload\/product\/|dspimg|detail|pdp|product|goods|contents/i.test(imageUrl);
}

function isReviewImageUrl(imageUrl: string): boolean {
  return /fileupload\/reviews|\/reviews?\//i.test(imageUrl);
}

function textAroundImage($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  const figureText = cleanText(element.closest("figure").find("figcaption").first().text());
  const parent = element.parent();
  const parentTag = parent.get(0)?.tagName?.toLowerCase();
  const parentText = parentTag === "figure" ? cleanText(parent.text()) : "";
  return unique([figureText, parentText].filter((text) => text.length > 0)).join(" ").slice(0, 520);
}

function imageOcrEvidenceContext($: ReturnType<typeof load>, node: CheerioInput): ImageOcrContext {
  const element = $(node);
  const tokens: string[] = [
    nodeAttributeText($, node),
    element.attr("alt") ?? "",
    element.attr("title") ?? "",
    element.attr("aria-label") ?? ""
  ];
  let hasProductEvidenceSection = false;
  let hasNegativeSection = false;
  let sectionKey = "";

  element.parents().slice(0, 8).each((depth, parent) => {
    const parentElement = $(parent);
    const parentToken = cleanText([
      nodeAttributeText($, parent),
      parentElement.children("h1,h2,h3,h4,h5,h6,summary").first().text(),
      parentElement.prevAll("h1,h2,h3,h4,h5,h6").first().text()
    ].join(" "));

    if (!parentToken) {
      return;
    }

    tokens.push(parentToken);
    hasProductEvidenceSection = hasProductEvidenceSection || isPositiveOcrSectionText(parentToken);
    hasNegativeSection = hasNegativeSection || isNegativeOcrSectionText(parentToken);

    if (!sectionKey && (depth >= 1 || isPositiveOcrSectionText(parentToken) || isNegativeOcrSectionText(parentToken))) {
      sectionKey = normalizeFingerprint(parentToken).slice(0, 100);
    }
  });

  const text = cleanText(tokens.join(" ")).slice(0, 900);

  return {
    text,
    sectionKey: sectionKey || normalizeFingerprint(text).slice(0, 100) || "image",
    hasProductEvidenceSection: hasProductEvidenceSection || isPositiveOcrSectionText(text),
    hasNegativeSection: hasNegativeSection || isNegativeOcrSectionText(text)
  };
}

function imageOcrContextFromText(value: string, fallbackKey: string): ImageOcrContext {
  const text = normalizeRawImageContextText(value).slice(0, 900);

  return {
    text,
    sectionKey: normalizeFingerprint(text).slice(0, 100) || fallbackKey,
    hasProductEvidenceSection: isPositiveOcrSectionText(text),
    hasNegativeSection: isNegativeOcrSectionText(text)
  };
}

function normalizeRawImageContextText(value: string): string {
  return cleanText(decodeHtmlEntities(value)
    .replace(/[<>"'`=]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\/\s*/g, " ")
    .replace(/[{}[\]();:,]+/g, " "));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function isPositiveOcrSectionText(value: string): boolean {
  return /product[-_\s]*(detail|media|gallery|image|info)|pdp|detail|description|overview|summary|technical|technology|ingredient|formula|clinical|result|efficacy|benefit|before|after|how[-_\s]*to[-_\s]*use|how\s*to\s*use|routine|ritual|direction|usage|apply|상품\s*상세|상품\s*정보|제품\s*정보|기술|기술서|성분|효능|효과|임상|결과|사용법/i.test(value);
}

function isNegativeOcrSectionText(value: string): boolean {
  return /recommend|related|you may also like|recently viewed|product[-_\s]*(tile|card|recommendation)|routine[-_\s]*builder|quick\s*add|review|ugc|rating|reward|offer|promo|promotion|gift|sample|bundle|set-item|cart|checkout|shipping|return|refund|footer|header|navigation|nav|menu|logo|icon|account|search|wishlist|collection|blog|article|press|social|instagram|tiktok|youtube|추천|관련\s*상품|리뷰|후기|혜택|오퍼|프로모션|장바구니|배송|반품|푸터|헤더|메뉴|검색|위시/i.test(value);
}

function isCommerceImageOcrContext(value: string): boolean {
  return /product[-_\s]*(tile|card|recommendation)|routine[-_\s]*builder|quick\s*add|customers?\s+were\s+interested|you may also like|related[-_\s]*products?|product[-_\s]*recommendations?|cross[-_\s]*sell|upsell|recently viewed|추천|관련\s*상품/i.test(value);
}

function isGalleryLikeOcrContext(value: string): boolean {
  return /gallery|media|carousel|slider|swiper|slick|thumbnail|thumb|product[-_\s]*image|product[-_\s]*media|이미지|갤러리|썸네일/i.test(value);
}

function isHighValueOcrEvidenceContext(value: string): boolean {
  return /clinical|result|before|after|ingredient|formula|technology|efficacy|benefit|how[-_\s]*to[-_\s]*use|how\s*to\s*use|routine|ritual|direction|usage|임상|결과|성분|기술|효능|효과|사용법/i.test(value);
}

function hasProductNameSignal(value: string, productName: string): boolean {
  const text = value.toLowerCase();
  const terms = productName
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter((term) => term.length >= 4 && !productNameStopWords.has(term));

  if (terms.length === 0) {
    return false;
  }

  return terms.some((term) => text.includes(term));
}

function hasConflictingProductType(value: string, productName: string): boolean {
  const currentTypes = productTypeTokens(productName);
  if (currentTypes.size === 0) {
    return false;
  }

  const candidateTypes = productTypeTokens(value);
  if (candidateTypes.size === 0) {
    return false;
  }

  return !Array.from(candidateTypes).some((type) => currentTypes.has(type));
}

function productTypeTokens(value: string): Set<string> {
  const text = value.toLowerCase();
  const types = new Set<string>();
  const patterns: Array<[string, RegExp]> = [
    ["serum", /serum|세럼|앰플|ampoule/],
    ["cream", /cream|크림|balm|밤/],
    ["toner", /toner|토너|skin\s*softener|softener/],
    ["essence", /essence|에센스/],
    ["cleanser", /cleanser|cleansing|foam|oil\s*cleanser|클렌저|클렌징/],
    ["mask", /mask|masque|팩|마스크/],
    ["eye", /eye\s*(cream|serum|care)|아이\s*(크림|세럼|케어)/],
    ["sunscreen", /sunscreen|sun\s*cream|spf|선크림|자외선/],
    ["lotion", /lotion|로션|emulsion|에멀전/]
  ];

  for (const [type, pattern] of patterns) {
    if (pattern.test(text)) {
      types.add(type);
    }
  }

  return types;
}

const productNameStopWords = new Set([
  "with",
  "and",
  "the",
  "for",
  "skin",
  "care",
  "brand",
  "product"
]);

function canonicalOcrImageKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    const pathname = url.pathname.replace(/_(?:\d+x\d*|x\d+)(?=\.[a-z]{3,5}$)/i, "");
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return imageUrl.split(/[?#]/)[0]?.toLowerCase() ?? imageUrl.toLowerCase();
  }
}

function imageVariantWidth(imageUrl: string): number {
  try {
    const url = new URL(imageUrl);
    const queryWidth = Number(url.searchParams.get("width") ?? url.searchParams.get("w"));
    if (Number.isFinite(queryWidth) && queryWidth > 0) {
      return queryWidth;
    }
  } catch {
    // Fall through to path-based width parsing.
  }

  return Number(imageUrl.match(/_(\d+)x(?:\d+)?(?=\.)/i)?.[1] ?? 0);
}

function createApiTextCandidates(
  source: string,
  productSource: Record<string, unknown>,
  description: string | undefined,
  keyedProductSections: ProductContentSection[] = []
): OcrTextCandidate[] {
  const bodyText = htmlToText(stringValue(productSource.body_html) ?? stringValue(productSource.bodyHtml) ?? "");
  const productSectionText = unique([
    ...htmlishValues(productSource.benefits),
    ...htmlishValues(productSource.effects),
    ...htmlishValues(productSource.ingredients),
    ...htmlishValues(productSource.keyIngredients),
    ...htmlishValues(productSource.ingredientHighlights),
    ...htmlishValues(productSource.usage),
    ...htmlishValues(productSource.howToUse),
    ...htmlishValues(productSource.how_to_use),
    ...htmlishValues(productSource.directions),
    ...keyedProductSections.map((section) => section.text)
  ]);

  return unique([
    description,
    bodyText,
    ...arrayValues(productSource.summary),
    ...arrayValues(productSource.highlights),
    ...productSectionText
  ])
    .flatMap((text, index) =>
      chunkText(text, 920).slice(0, 6).map((chunk, chunkIndex) => ({
        imageUrl: `${source}#api-text-${index + 1}-${chunkIndex + 1}`,
        text: chunk
      }))
    )
    .filter((item) => item.text.length >= 24);
}

async function createRagChunks(
  source: string,
  product: ProductProfile,
  reviews: ReviewSummary,
  ocr: OcrExtraction,
  options: ProductExtractorOptions,
  runtimeSteps: RuntimePipelineStep[]
): Promise<RagChunk[]> {
  const chunks: RagChunk[] = [
    {
      id: "product-1",
      kind: "product" as const,
      text: [
        product.name,
        product.description,
        product.benefits.join("\n"),
        product.effects.join("\n"),
        product.ingredients.join("\n"),
        product.usage.join("\n"),
        product.metrics.join("\n")
      ].filter(Boolean).join("\n"),
      metadata: { source }
    },
    ...product.faq.map((item, index) => ({
      id: `faq-${index + 1}`,
      kind: "faq" as const,
      text: `Q: ${item.question}\nA: ${item.answer}`,
      metadata: { source }
    })),
    ...product.contentSections.map((item, index) => ({
      id: `content-section-${index + 1}`,
      kind: "source" as const,
      text: `[${item.category}] ${item.title}\n${item.text}`,
      metadata: { source, category: item.category }
    })),
    ...reviews.items.map((item, index) => ({
      id: `review-${index + 1}`,
      kind: "review" as const,
      text: item.body,
      metadata: { source, rating: item.rating ?? 0 }
    })),
    ...ocr.extractedTexts.map((item, index) => ({
      id: `ocr-${index + 1}`,
      kind: "ocr" as const,
      text: item.text,
      metadata: { source, imageUrl: item.imageUrl, confidence: item.confidence }
    }))
  ];

  if (options.analysisPrompt) {
    chunks.push({
      id: "rag-profile-analysis-prompt",
      kind: "source",
      text: options.analysisPrompt,
      metadata: { source, profile: "analysis-prompt" }
    });
  }

  const retrievedPolicyChunks = retrieveProductExtractorRagDocuments({
    query: createProductExtractorRagQuery({
      source,
      productName: product.name,
      imageTexts: [
        ...ocr.extractedTexts.map((item) => ({
          imageUrl: item.imageUrl,
          text: item.text
        })),
        {
          imageUrl: `${source}#product-evidence`,
          text: [
            product.name,
            product.description,
            product.benefits.join("\n"),
            product.effects.join("\n"),
            product.ingredients.join("\n"),
            product.usage.join("\n"),
            reviews.keywords.map((keyword) => keyword.keyword).join("\n")
          ].filter(Boolean).join("\n")
        }
      ]
    }),
    documents: options.ragDocuments ?? [],
    settings: options.rag,
    embedding: options.embedding,
    reranker: options.reranker,
    onRuntimeStep: (step) => runtimeSteps.push(step)
  });

  for (const [index, document] of (await retrievedPolicyChunks).entries()) {
    chunks.push({
      id: `rag-profile-file-${index + 1}`,
      kind: "source",
      text: document.content,
      metadata: {
        source,
        documentName: document.sourceDocument,
        chunkId: document.chunkId,
        score: document.score,
        kind: document.kind,
        intents: document.intents.join(","),
        fieldTargets: document.fieldTargets.join(",")
      }
    });
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
}

function createProductExtractorRagUsageDiagnostics(ragChunks: RagChunk[]): ProductExtractorRagUsageDiagnostic[] {
  const references = ragChunks
    .filter((chunk) => typeof chunk.metadata.documentName === "string")
    .map((chunk) => {
      const intents = parseMetadataList(chunk.metadata.intents);
      const fieldTargets = parseMetadataList(chunk.metadata.fieldTargets);

      return {
        sourceDocument: String(chunk.metadata.documentName),
        chunkId: scalarString(chunk.metadata.chunkId),
        kind: scalarString(chunk.metadata.kind),
        intents,
        fieldTargets,
        score: scalarNumber(chunk.metadata.score),
        usage: describeExtractorRagUsage(intents, fieldTargets),
        excerpt: compactRagExcerpt(chunk.text)
      };
    });

  if (references.length === 0) {
    return [];
  }

  return [
    {
      principle: "policy orchestration and overlap control",
      references: references.filter((reference) => reference.intents.includes("orchestration") || reference.fieldTargets.includes("diagnostics"))
    },
    {
      principle: "field classification and normalization",
      references: references.filter((reference) => reference.intents.some((intent) => ["classification", "normalization", "schema-ready"].includes(intent)))
    },
    {
      principle: "evidence exclusions and missing-field safety",
      references: references.filter((reference) => reference.intents.includes("exclusion") || reference.intents.includes("evidence"))
    }
  ].map((item) => ({
    ...item,
    references: uniqueRagUsageReferences(item.references)
  })).filter((item) => item.references.length > 0);
}

function describeExtractorRagUsage(intents: string[], fieldTargets: string[]): string {
  if (intents.includes("orchestration")) {
    return "Coordinates policy coverage, conflict handling, and omitted-field review before extraction output is trusted.";
  }
  if (intents.includes("exclusion")) {
    return "Prevents commerce chrome, coupon, delivery, refund, and legal text from becoming product claims.";
  }
  if (fieldTargets.includes("ocr.sentenceInsights")) {
    return "Guides sentence-level OCR reconstruction and category assignment.";
  }
  if (fieldTargets.includes("reviews")) {
    return "Guides review keyword and representative customer-language extraction.";
  }
  if (fieldTargets.includes("faq")) {
    return "Guides FAQ extraction only when question and answer evidence are both present.";
  }
  return "Guides source-backed product normalization and schema-ready RAG chunk construction.";
}

function uniqueRagUsageReferences(
  references: ProductExtractorRagUsageDiagnostic["references"]
): ProductExtractorRagUsageDiagnostic["references"] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.sourceDocument}:${reference.chunkId ?? ""}:${reference.excerpt.slice(0, 80)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseMetadataList(value: string | number | boolean | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function scalarString(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function scalarNumber(value: string | number | boolean | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRagExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 260);
}

function createGeoProductRawData(
  product: ProductProfile,
  reviews: ReviewSummary,
  ocr: OcrExtraction,
  ragChunks: RagChunk[],
  semanticFacts: GeoSemanticFacts,
  dateModified?: string
): GeoProductRawData {
  const productOcrEvidence = ocr.extractedTexts.filter((item) => isProductEvidenceCandidate("", item.text));
  const ocrTexts = unique(productOcrEvidence.map((item) => item.text));
  const ocrSentenceInsights = toGeoSentenceInsights(productOcrEvidence);
  const ocrSentenceSignals = createSentenceSignalBuckets(productOcrEvidence.flatMap((item) => item.sentenceInsights));
  const productTexts = [
    product.name,
    product.brand,
    product.price,
    product.description,
    ...product.benefits,
    ...product.effects,
    ...product.ingredients,
    ...product.usage,
    ...product.metrics,
    ...product.contentSections.map((section) => section.text),
    ...product.faq.flatMap((item) => [item.question, item.answer]),
    ...reviews.items.map((item) => item.body),
    ...ocrTexts
  ].filter((text): text is string => typeof text === "string" && text.length > 0 && !isNonProductCommerceText(text));
  const allKeywords = mergeKeywords(
    reviews.keywords,
    productOcrEvidence.flatMap((item) => item.keywords),
    ...productTexts.map((text) => keywordsFromTextAcrossCategories(text, "dom"))
  );
  const keywordGroups = toGeoKeywordGroups(allKeywords);
  const metrics = unique([
    ...product.metrics,
    ...productTexts.flatMap(extractMetricPhrases)
  ]).filter((item) => isSemanticFieldValue(item, "metric")).slice(0, 16);
  const contentSections = uniqueContentSections([
    ...product.contentSections,
    ...ocr.extractedTexts.map((item, index): ProductContentSection => {
      const category = sectionCategory(`OCR image ${index + 1}`, item.text, item.keywords);
      return createContentSection(`OCR image ${index + 1}`, category, item.text) ?? {
        title: `OCR image ${index + 1}`,
        category: "unknown",
        text: item.text.slice(0, 1600),
        bullets: summarizeContentBullets(item.text)
      };
    }),
    ...reviews.items.map((item, index): ProductContentSection => ({
      title: `Customer review ${index + 1}`,
      category: "review",
      text: item.body,
      bullets: summarizeContentBullets(item.body)
    })),
    ...ratingSummarySection(reviews)
  ]).slice(0, OCR_EVIDENCE_LIMIT);
  const ratingSummary = createRatingSummary(reviews);
  const sectionDeclaredTexts = declaredSectionTexts(
    productOcrEvidence.flatMap((item) => item.sentenceInsights)
  );
  const fieldValuesWithDeclaredRelations = (values: string[], category: ProductFieldRole, limit: number) =>
    valuesWithDeclaredRelationsExempt(values, sectionDeclaredTexts, category, limit);
  const benefits = fieldValuesWithDeclaredRelations([...product.benefits, ...ocrSentenceSignals.benefits], "benefit", 12);
  const effects = fieldValuesWithDeclaredRelations([...product.effects, ...ocrSentenceSignals.effects], "effect", 12);
  const ingredients = fieldValuesWithDeclaredRelations([...product.ingredients, ...ocrSentenceSignals.ingredients], "ingredient", 16);
  const usage = fieldValuesWithDeclaredRelations([...product.usage, ...ocrSentenceSignals.usage], "usage", 16);
  const reviewKeywords = unique(
    customerReviewKeywords([
      ...reviews.keywords,
      ...reviews.items.flatMap((item) => keywordsFromText(item.body, "review"))
    ]).map((keyword) => keyword.keyword)
  ).slice(0, 24);
  const reviewSignals = unique([
    ...reviews.items.flatMap((item) => summarizeContentBullets(item.body)),
    ...reviewKeywords
  ]).slice(0, 24);
  const categorizedProductInfo = {
    benefits: benefits.length > 0 ? benefits : semanticFieldValues(keywordGroups.benefit, "benefit", 12),
    effects: effects.length > 0 ? effects : semanticFieldValues(keywordGroups.effect, "effect", 12),
    ingredients: ingredients.length > 0 ? ingredients : semanticFieldValues(keywordGroups.ingredient, "ingredient", 16),
    usage: usage.length > 0 ? usage : semanticFieldValues(keywordGroups.usage, "usage", 16),
    metrics,
    faq: product.faq
  };

  return {
    name: product.name,
    dateModified,
    brand: product.brand,
    price: product.price
      ? {
          raw: product.price,
          amount: priceAmount(product.price),
          currency: product.currency
        }
      : undefined,
    availability: product.availability,
    itemCondition: product.itemCondition,
    priceValidUntil: product.priceValidUntil,
    returnPolicy: product.returnPolicy,
    description: product.description,
    images: product.images,
    options: product.options,
    benefits: categorizedProductInfo.benefits,
    effects: categorizedProductInfo.effects,
    ingredients: categorizedProductInfo.ingredients,
    usage: categorizedProductInfo.usage,
    metrics,
    faq: product.faq,
    reviews: {
      rating: reviews.rating,
      reviewCount: reviews.reviewCount,
      items: reviews.items,
      keywords: reviewKeywords.slice(0, 20)
    },
    sourceExtraction: {
      html: {
        description: product.description,
        sections: product.contentSections,
        faq: product.faq
      },
      ocr: {
        imageTexts: ocr.extractedTexts
          .filter((item) => isImageOcrEvidence(item.imageUrl))
          .map((item) => ({
            imageUrl: item.imageUrl,
            text: item.text,
            ...(item.imageUrls ? { imageUrls: item.imageUrls } : {}),
            confidence: item.confidence
          })),
        textBlocks: ocrTexts.slice(0, OCR_EVIDENCE_LIMIT),
        sentenceInsights: ocrSentenceInsights,
        semanticFacts
      }
    },
    aiAnalysis: {
      keywords: keywordGroups,
      categorizedSections: contentSections,
      summary: createAiAnalysisSummary(categorizedProductInfo, reviews, ocr),
      semanticFacts
    },
    semanticFacts,
    categorizedProductInfo,
    customerReviewAnalysis: {
      rating: reviews.rating,
      reviewCount: reviews.reviewCount,
      items: reviews.items,
      keywords: reviewKeywords,
      reviewSignals,
      ratingSummary
    },
    contentAnalysis: {
      sections: contentSections,
      reviewSignals,
      ratingSummary
    },
    ocr: {
      textBlocks: ocrTexts.slice(0, OCR_EVIDENCE_LIMIT),
      keywords: keywordGroups,
      sentenceInsights: ocrSentenceInsights
    },
    rag: {
      chunks: ragChunks.map((chunk) => ({
        id: chunk.id,
        kind: chunk.kind,
        text: chunk.text
      }))
    }
  };
}

function toGeoKeywordGroups(keywords: ClassifiedKeyword[]): GeoKeywordGroups {
  const groups: GeoKeywordGroups = {
    product: [],
    price: [],
    benefit: [],
    effect: [],
    ingredient: [],
    usage: [],
    faq: [],
    review: [],
    metric: [],
    trend: [],
    unknown: []
  };

  for (const keyword of keywords) {
    if (isSemanticFieldValue(keyword.keyword, keyword.category)) {
      groups[keyword.category].push(keyword.keyword);
    }
  }

  return {
    product: unique(groups.product).slice(0, 12),
    price: unique(groups.price).slice(0, 12),
    benefit: unique(groups.benefit).slice(0, 12),
    effect: unique(groups.effect).slice(0, 12),
    ingredient: unique(groups.ingredient).slice(0, 12),
    usage: unique(groups.usage).slice(0, 12),
    faq: unique(groups.faq).slice(0, 12),
    review: unique(groups.review).slice(0, 12),
    metric: unique(groups.metric).slice(0, 12),
    trend: unique(groups.trend).slice(0, 12),
    unknown: unique(groups.unknown).slice(0, 12)
  };
}

function createAiAnalysisSummary(
  productInfo: GeoProductRawData["categorizedProductInfo"],
  reviews: ReviewSummary,
  ocr: OcrExtraction
): string {
  return [
    `HTML product sections categorized into benefits(${productInfo.benefits.length}), effects(${productInfo.effects.length}), ingredients(${productInfo.ingredients.length}), usage(${productInfo.usage.length}), metrics(${productInfo.metrics.length}), and FAQ(${productInfo.faq.length}).`,
    `OCR evidence collected from ${ocr.extractedTexts.length} image/text blocks and classified into product categories.`,
    reviews.items.length > 0 || reviews.rating || reviews.reviewCount
      ? `Customer review evidence includes ${reviews.items.length} review texts${reviews.rating ? `, rating ${reviews.rating}` : ""}${reviews.reviewCount ? `, ${reviews.reviewCount} reviews` : ""}.`
      : "No customer review text evidence was found on the page."
  ].join(" ");
}

function isImageOcrEvidence(imageUrl: string): boolean {
  return !/#(?:page-section|api-text)/i.test(imageUrl);
}

function semanticFieldValues(
  values: string[],
  category: ProductFieldRole,
  limit: number
): string[] {
  return unique(values.map(cleanText).filter((value) => isSemanticFieldValue(value, category))).slice(0, limit);
}

function isSemanticFieldValue(value: string, category: ClassifiedKeyword["category"]): boolean {
  const text = cleanText(value);

  if (text.length === 0 || isNonProductCommerceText(text)) {
    return false;
  }

  if (category === "usage") {
    return !/^(use|사용|주의|face|neck|얼굴|목)$/i.test(text) && isUsageInstructionSentence(text);
  }

  if (category === "benefit") {
    return !/^(혜택|benefit|장점)$/i.test(text)
      && !/(할인|쿠폰|구매|배송|반품|교환|적립|혜택 적용가|benefit price|reward|point)/i.test(text)
      && /(보습|수분|진정|탄력|장벽|광채|영양|고밀도|자생력|피부|hydration|moisture|soothing|brightening|firming|firmness|radiance|elasticity|resilience|plumpness)/i.test(text);
  }

  if (category === "effect") {
    return !/^(효과|개선|케어|care|effect|improvement)$/i.test(text) && /(주름|잔주름|피부결|리프팅|탄력|개선|완화|효과|firmness|firmer|elastic|texture|even|wrinkles?|fine lines|lift|improve|improved|reduce|diminish|diminished)/i.test(text);
  }

  if (category === "ingredient") {
    if (isFullIngredientList(text)) {
      return true;
    }
    return /(인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민|성분|ginseng|panax|retinol|niacinamide|peptide|hyaluronic|ceramide|collagen|vitamin|water|aqua|glycerin|extract)/i.test(text);
  }

  if (category === "metric") {
    return /(\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?)\b|\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b)/i.test(text)
      && !/(할인|쿠폰|배송비|상품가|혜택 적용가|discount|sale|shipping)/i.test(text);
  }

  if (category === "review") {
    return isReviewEvidenceText(text);
  }

  return true;
}

function priceAmount(value: string): number | undefined {
  const normalized = value.replace(/[^\d.]/g, "");
  return normalized.length > 0 ? numberValue(normalized) : undefined;
}

function extractMetricPhrases(text: string | undefined): string[] {
  if (!text || isNonProductCommerceText(text)) {
    return [];
  }

  return unique([
    ...(text.match(/\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?)\b/gi) ?? []),
    ...(text.match(/\b(?:after|in)\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)\b/gi) ?? []),
    ...(text.match(/\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b/g) ?? [])
  ]).slice(0, 8);
}

function resolveRuntimeRagOptions(options: ProductExtractorOptions): ProductExtractorOptions {
  const analysisPrompt = options.analysisPrompt?.trim() || defaultProductExtractorRagProfile.analysisPrompt;
  const ragDocuments = options.ragDocuments && options.ragDocuments.length > 0
    ? options.ragDocuments
    : defaultProductExtractorRagProfile.documents.map((document) => ({
        name: document.name,
        content: document.content
      }));

  return {
    ...options,
    analysisPrompt,
    ragDocuments
  };
}

function resolveProviderConfig(options: ProductExtractorOptions) {
  const provider = options.provider ?? "mock";
  return {
    provider,
    apiKey: options.apiKey,
    model: options.model,
    endpoint: options.endpoint,
    deployment: options.deployment,
    deployments: options.deployments,
    apiVersion: options.apiVersion,
    temperature: options.temperature,
    embedding: options.embedding,
    reranker: options.reranker
  };
}

function createModelRuntimeStep(
  stage: "ocr" | "final",
  label: string,
  options: ProductExtractorOptions,
  deploymentRole: "ocr" | "reasoning",
  tokenUsage: AiTokenUsage | undefined,
  details: string
): RuntimePipelineStep {
  const config = resolveProviderConfig(options);
  return {
    stage,
    label,
    provider: runtimeProviderLabel(config.provider),
    service: deploymentServiceLabel(config.provider) ?? config.provider,
    model: usesDeployments(config.provider) ? undefined : config.model,
    deployment: usesDeployments(config.provider) ? config.deployments?.[deploymentRole] ?? config.deployment : undefined,
    called: true,
    tokenUsage,
    details
  };
}

function createExtractorRuntimeUsage(options: ProductExtractorOptions, observedSteps: RuntimePipelineStep[]): RuntimePipelineUsage {
  const config = resolveProviderConfig(options);
  const embedding = config.embedding;
  const reranker = config.reranker;
  const baseline: RuntimePipelineStep[] = [
    {
      stage: "ocr",
      label: "OCR/structure extraction",
      provider: runtimeProviderLabel(config.provider),
      service: deploymentServiceLabel(config.provider) ?? config.provider,
      model: usesDeployments(config.provider) ? undefined : config.model,
      deployment: usesDeployments(config.provider) ? config.deployments?.ocr ?? config.deployment : undefined,
      called: observedSteps.some((step) => step.stage === "ocr"),
      details: "Reads visible text from PDP images when image OCR targets are available."
    },
    {
      stage: "final",
      label: "Final OCR classification/reasoning",
      provider: runtimeProviderLabel(config.provider),
      service: deploymentServiceLabel(config.provider) ?? config.provider,
      model: usesDeployments(config.provider) ? undefined : config.model,
      deployment: usesDeployments(config.provider) ? config.deployments?.reasoning ?? config.deployment : undefined,
      called: observedSteps.some((step) => step.stage === "final"),
      details: "Classifies OCR/detail-page text into product, benefit, effect, ingredient, usage, FAQ, review, price, and metric signals."
    },
    {
      stage: "embedding",
      label: "Embedding",
      provider: embedding?.provider === "aistudio" ? "aistudio" : embedding?.provider === "azure-openai" ? "azure-api" : "local",
      service: embedding?.provider === "aistudio"
        ? "AI Studio embedding deployment"
        : embedding?.provider === "azure-openai" ? "Azure API embedding deployment" : "local hash embedding",
      model: embedding?.model,
      deployment: embedding?.deployment,
      called: observedSteps.some((step) => step.stage === "embedding") || (embedding?.provider !== "azure-openai" && embedding?.provider !== "aistudio"),
      details: embedding?.provider === "aistudio"
        ? "Embeds extractor RAG policy query and candidate chunks through the AI Studio embedding deployment when configured."
        : embedding?.provider === "azure-openai"
          ? "Embeds extractor RAG policy query and candidate chunks when Azure embedding credentials are configured."
          : "Uses deterministic local embedding for extractor RAG policy retrieval."
    },
    {
      stage: "retrieval",
      label: "Retrieval",
      provider: "local",
      service: "section-aware local hybrid retrieval",
      mode: "BM25-like lexical + deterministic vector scoring",
      called: true,
      details: "Retrieves extractor RAG policy chunks before OCR classification and RAG chunk generation."
    },
    {
      stage: "reranking",
      label: "Reranking",
      provider: reranker?.provider ?? "local-hybrid",
      service: reranker?.provider === "azure-ai-search-semantic"
        ? "Azure AI Search semantic ranker"
        : reranker?.provider === "aistudio-bedrock-cohere"
          ? "AI Studio Bedrock Cohere Rerank"
          : reranker?.provider === "cohere" ? "Cohere Rerank" : "local score ordering",
      model: reranker?.provider === "cohere" || reranker?.provider === "aistudio-bedrock-cohere" ? reranker.model : undefined,
      called: observedSteps.some((step) => step.stage === "reranking") || !reranker || reranker.provider === "local-hybrid",
      details: reranker?.provider === "azure-ai-search-semantic"
        ? `Uses Azure AI Search index ${reranker.indexName || "(not set)"} with semantic configuration ${reranker.semanticConfiguration || "default"}.`
        : reranker?.provider === "aistudio-bedrock-cohere"
          ? "Uses AI Studio's Bedrock Cohere Rerank when endpoint/key are configured; otherwise falls back to local score ordering."
          : reranker?.provider === "cohere"
            ? "Uses Cohere Rerank when endpoint/key are configured; otherwise falls back to local score ordering."
            : "Uses deterministic local score ordering."
    }
  ];
  const steps = mergeRuntimeSteps([...baseline, ...observedSteps]);
  const tokenTotals = mergeTokenUsages(steps.map((step) => step.tokenUsage).filter((usage): usage is AiTokenUsage => Boolean(usage)));

  return {
    steps,
    tokenTotals: tokenTotals ?? {},
    tokenNote: tokenTotals
      ? "Token counts are summed from provider usage metadata returned by model APIs."
      : "Token counts were not returned or do not apply to deterministic/search-only stages."
  };
}

function mergeRuntimeSteps(steps: RuntimePipelineStep[]): RuntimePipelineStep[] {
  const merged = new Map<string, RuntimePipelineStep>();
  for (const step of steps) {
    const key = step.label;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, step);
      continue;
    }
    merged.set(key, {
      ...current,
      ...step,
      called: current.called || step.called,
      tokenUsage: mergeTokenUsages([current.tokenUsage, step.tokenUsage].filter((usage): usage is AiTokenUsage => Boolean(usage))),
      details: [current.details, step.details].filter(Boolean).join(" ")
    });
  }
  return Array.from(merged.values());
}

function mergeTokenUsages(usages: AiTokenUsage[]): AiTokenUsage | undefined {
  const merged = usages.reduce<AiTokenUsage>((total, usage) => ({
    inputTokens: sumOptional(total.inputTokens, usage.inputTokens),
    outputTokens: sumOptional(total.outputTokens, usage.outputTokens),
    totalTokens: sumOptional(total.totalTokens, usage.totalTokens)
  }), {});
  return merged.inputTokens !== undefined || merged.outputTokens !== undefined || merged.totalTokens !== undefined ? merged : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function runtimeProviderLabel(provider: ProductExtractorOptions["provider"]): string {
  if (provider === "azure-openai") {
    return "azure-api";
  }
  if (provider === "aistudio") {
    return "external-agent";
  }
  return provider ?? "mock";
}

/** Providers that address models by deployment/model id over a shared endpoint (Azure-style contract). */
function usesDeployments(provider: ProductExtractorOptions["provider"]): boolean {
  return provider === "azure-openai" || provider === "aistudio";
}

/** Service label for deployment-based providers; undefined for non-deployment providers. */
function deploymentServiceLabel(provider: ProductExtractorOptions["provider"]): string | undefined {
  if (provider === "azure-openai") {
    return "Azure API model deployment";
  }
  if (provider === "aistudio") {
    return "AI Studio model deployment";
  }
  return undefined;
}

function extractOptions($: ReturnType<typeof load>, productNode?: Record<string, unknown>): string[] {
  return unique([
    ...arrayValues(productNode?.color),
    ...arrayValues(productNode?.size),
    ...$("select option, [data-option], [data-option-value], [data-variant-option], [aria-label*='옵션'], [aria-label*='option']")
      .toArray()
      .flatMap((node) => optionTextsFromNode($, node))
  ].filter(isProductOptionText)).slice(0, 12);
}

function optionTextsFromNode($: ReturnType<typeof load>, node: CheerioInput): string[] {
  const element = $(node);
  return [
    element.attr("data-option"),
    element.attr("data-option-value"),
    element.attr("data-variant-option"),
    element.attr("aria-label"),
    element.text()
  ].map((item) => cleanText(item ?? ""));
}

function isProductOptionText(text: string): boolean {
  const value = cleanText(text);

  if (value.length === 0 || value.length > 80 || isNonProductCommerceText(value)) {
    return false;
  }

  if (/^(총 상품가|혜택 적용가|장바구니|구매하기|상품을 선택해주세요|선택|옵션|[-+]?|\d+|[0-9,]+원)$/i.test(value)) {
    return false;
  }

  return /(\d+(?:\.\d+)?\s?(?:ml|mL|g|kg|oz|호|매|개입|입|세트)|단품|세트|리필|본품|기획|색상|컬러|호수|shade|size|set|refill|크림|세럼|에센스|앰플|토너|로션)/i.test(value);
}

function keywordsFromReviews(items: ReviewItem[]): ClassifiedKeyword[] {
  return items.flatMap((item) => keywordsFromText(item.body, "review")).slice(0, 20);
}

function keywordsFromText(text: string, category: ClassifiedKeyword["category"], source?: ClassifiedKeyword["source"]): ClassifiedKeyword[] {
  const matchers: Partial<Record<ClassifiedKeyword["category"], RegExp>> = {
    product: /(serum|cream|essence|ampoule|toner|lotion|cleanser|mask|선크림|세럼|크림|에센스|앰플|토너|로션|마스크)/gi,
    price: /(?:\$|₩)\s*[\d,.]+|[\d,]+\s*원|price|sale|discount|가격|할인/gi,
    ingredient: /(ginseng|retinol|niacinamide|peptide|hyaluronic|ceramide|collagen|panax|vitamin|성분|원료|보태니컴플렉스|인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민)/gi,
    benefit: /(보습|수분|진정|탄력|장벽|광채|영양|고밀도|자생력|hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|plumpness)/gi,
    effect: /(효과|개선|완화|케어|주름|잔주름|피부결|리프팅|effect|improve|improved|improvement|care|reduce|diminish|diminished|fine lines|wrinkles|texture|even|elastic|firmer|lift|lifting|firmness)/gi,
    usage: /(use|apply|morning|night|ritual|pump|face|neck|사용|도포|아침|저녁|루틴|펌프|얼굴|목)/gi,
    faq: /\?|faq|question|answer|what are|how does|can i|자주|질문|답변/gi,
    review: /(촉촉|흡수|만족|재구매|가벼운|산뜻|review|rating|customer|smooth|satisfied|repurchase|stars)/gi,
    metric: /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?|점|개|명|회|주|일|시간|퍼센트)\b/gi
  };
  const matcher = matchers[category];
  if (!matcher) {
    return [];
  }
  return unique(Array.from(text.matchAll(matcher)).map((match) => match[0])).map((keyword) => ({
    keyword,
    category,
    confidence: 0.66,
    source: source ?? (category === "review" ? "review" : "dom")
  }));
}

function keywordsFromTextAcrossCategories(text: string, source: ClassifiedKeyword["source"]): ClassifiedKeyword[] {
  return mergeKeywords(
    keywordsFromText(text, "product", source),
    keywordsFromText(text, "price", source),
    keywordsFromText(text, "ingredient", source),
    keywordsFromText(text, "benefit", source),
    keywordsFromText(text, "effect", source),
    keywordsFromText(text, "usage", source),
    keywordsFromText(text, "faq", source),
    keywordsFromText(text, "review", source),
    keywordsFromText(text, "metric", source)
  );
}

function selectKeywordTexts(keywords: ClassifiedKeyword[], category: ClassifiedKeyword["category"]): string[] {
  return unique(keywords.filter((keyword) => keyword.category === category).map((keyword) => keyword.keyword)).slice(0, 8);
}

function mergeKeywords(...groups: ClassifiedKeyword[][]): ClassifiedKeyword[] {
  const seen = new Set<string>();
  return groups.flat().filter((keyword) => {
    const id = `${keyword.category}:${keyword.keyword.toLowerCase()}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function readFaqArray(value: unknown): FaqItem[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .filter(isRecord)
    .map((item) => ({
      question: stringValue(item.name) ?? stringValue(item.question) ?? "",
      answer: stringValue(firstObject(item.acceptedAnswer)?.text) ?? stringValue(item.answer) ?? ""
    }))
    .filter((item) => item.question.length > 0 && item.answer.length > 0);
}

function readReviewArray(value: unknown): ReviewItem[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.filter(isRecord).map((item) => ({
    body: stringValue(item.reviewBody) ?? stringValue(item.body) ?? stringValue(item.description) ?? "",
    author: stringValue(firstObject(item.author)?.name) ?? stringValue(item.author),
    rating: numberValue(firstObject(item.reviewRating)?.ratingValue) ?? numberValue(item.rating),
    datePublished: stringValue(item.datePublished)
  })).filter((item) => item.body.length > 0);
}

function parseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function htmlishValues(value: unknown): string[] {
  return unique(arrayValues(value).map((item) => htmlToText(item) ?? cleanText(item)).filter(Boolean));
}

function htmlToText(value: string): string | undefined {
  const htmlWithSpacing = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<(?:p|div|li|tr|td|th|h[1-6])(?:\s[^>]*)?>/gi, "\n");
  const text = cleanText(load(htmlWithSpacing).text());
  return text.length > 0 ? text : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(isRecord);
}

function readImageUrls(value: unknown, source: string): string[] {
  return unique([
    ...arrayValues(value).map((item) => absoluteUrl(item, source)),
    ...arrayRecords(value).flatMap((item) => [
      absoluteUrl(stringValue(item.src), source),
      absoluteUrl(stringValue(item.url), source),
      absoluteUrl(stringValue(item.image), source),
      absoluteUrl(stringValue(item.imgUrl), source),
      absoluteUrl(stringValue(item.imageUrl), source),
      absoluteUrl(stringValue(item.thumbnailUrl), source),
      absoluteUrl(stringValue(item.originalSrc), source)
    ])
  ].filter(Boolean));
}

function readOptionValues(value: unknown): string[] {
  return unique(arrayRecords(value).flatMap((item) => [
    stringValue(item.name),
    ...arrayValues(item.values)
  ])).filter((item) => item.toLowerCase() !== "title");
}

function readVariantOptions(variants: Array<Record<string, unknown>>): string[] {
  return unique(variants.flatMap((variant) => [
    stringValue(variant.option1),
    stringValue(variant.option2),
    stringValue(variant.option3),
    stringValue(variant.title)
  ])).filter((item) => item.toLowerCase() !== "default title");
}


/**
 * Extracts a source-provided page last-modified date. Accepted sources:
 * page meta tags and date-bearing keys inside embedded JSON (Shopify
 * `updated_at`, JSON-LD `dateModified`). Never the extraction time — an
 * invented freshness signal is worse than none (schema policy §5).
 */
function extractPageDateModified($: ReturnType<typeof load>, html: string): string | undefined {
  const metaCandidates = [
    meta($, "article:modified_time"),
    meta($, "og:updated_time"),
    meta($, "dateModified"),
    meta($, "last-modified")
  ];
  for (const candidate of metaCandidates) {
    const sanitized = sanitizeSourceDateValue(candidate);
    if (sanitized) {
      return sanitized;
    }
  }
  const embedded = html.match(/"(?:dateModified|updated_at|modified_at|updatedAt)"\s*:\s*"([^"]{8,40})"/);
  return sanitizeSourceDateValue(embedded?.[1]);
}

/** Extracts a payload-provided last-modified date from common key shapes. */
function extractPayloadDateModified(payload: unknown): string | undefined {
  const serialized = JSON.stringify(payload ?? {});
  const match = serialized.match(/"(?:dateModified|updated_at|modified_at|updatedAt|lastModified)"\s*:\s*"([^"]{8,40})"/);
  return sanitizeSourceDateValue(match?.[1]);
}

/** Accepts ISO-like calendar dates only; rejects relative labels and junk. */
function sanitizeSourceDateValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  if (!text || text.length > 40 || !/^\d{4}[-./]\d{1,2}[-./]\d{1,2}([Tt ].*)?$/.test(text)) {
    return undefined;
  }
  return text;
}

function meta($: ReturnType<typeof load>, name: string): string | undefined {
  return cleanText($(`meta[name='${name}'], meta[property='${name}']`).first().attr("content") ?? "") || undefined;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeOcrText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstLongText(text: string): string | undefined {
  const sentences = text
    .split(/[.!?。！？]/)
    .map(cleanText)
    .filter((item) => item.length >= 24 && !isNonProductCommerceText(item));
  const sentence = sentences.find((item) => hasProductCareSignal(item)) ?? sentences.find((item) => item.length >= 60);

  return sentence?.slice(0, 260);
}

function findPrice(text: string): string | undefined {
  return text.match(/(?:[$€£¥]\s*)\d[\d,.]*|₩\s*\d[\d,.]*|\d[\d,.]*(?:\s*)(?:원|KRW|USD|EUR|JPY)/i)?.[0].replace(/[.,]+$/, "");
}

function absoluteUrl(value: string | undefined, source: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, source).toString();
  } catch {
    return value;
  }
}

function arrayValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(arrayValues);
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

/**
 * @graph에서 { "@id": ... } 참조 전용 객체를 실제 노드로 해석한다.
 * 인라인 객체(속성 보유)는 그대로 반환한다.
 */
function resolveJsonLdReference(
  nodes: Array<Record<string, unknown>>,
  value: unknown
): Record<string, unknown> | undefined {
  const record = firstObject(value);
  if (!record) {
    return undefined;
  }
  const ref = stringValue(record["@id"]);
  const isReferenceOnly = Boolean(ref) && Object.keys(record).every((key) => key === "@id" || key === "@type");
  if (ref && isReferenceOnly) {
    return nodes.find((node) => stringValue(node["@id"]) === ref) ?? record;
  }
  return record;
}

/** 반품 정책 원시 레코드를 입력 계약 형태로 읽는다(정규화는 downstream 담당). */
function readMerchantReturnPolicyRecord(value: unknown, source?: string): ProductProfile["returnPolicy"] {
  const record = firstObject(value);
  if (!record) {
    return undefined;
  }
  const category = stringValue(record.returnPolicyCategory ?? record.category);
  if (!category) {
    return undefined;
  }
  const days = Number(stringValue(record.merchantReturnDays ?? record.returnDays ?? record.days));
  return {
    category,
    merchantReturnDays: Number.isFinite(days) ? days : undefined,
    returnMethod: stringValue(record.returnMethod ?? record.method),
    returnFees: stringValue(record.returnFees ?? record.fees),
    applicableCountry: stringValue(record.applicableCountry ?? record.country),
    returnPolicyCountry: stringValue(record.returnPolicyCountry),
    url: absoluteCommerceUrl(stringValue(record.merchantReturnLink ?? record.url), source)
  };
}

function absoluteCommerceUrl(value: string | undefined, source?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return source ? new URL(value, source).toString() : new URL(value).toString();
  } catch {
    return undefined;
  }
}

/** 소스 JSON-LD의 Offer/Product/MerchantReturnPolicy에서 커머스 신뢰 필드를 관측한다. */
function extractCommerceTrustFromJsonLd(
  nodes: Array<Record<string, unknown>>,
  productNode: Record<string, unknown> | undefined,
  offer: Record<string, unknown> | undefined,
  source: string
): Pick<ProductProfile, "availability" | "itemCondition" | "priceValidUntil" | "returnPolicy"> {
  const policyNode = resolveJsonLdReference(nodes, offer?.hasMerchantReturnPolicy)
    ?? resolveJsonLdReference(nodes, productNode?.hasMerchantReturnPolicy);
  return {
    availability: stringValue(offer?.availability),
    itemCondition: stringValue(offer?.itemCondition) ?? stringValue(productNode?.itemCondition),
    priceValidUntil: stringValue(offer?.priceValidUntil),
    returnPolicy: readMerchantReturnPolicyRecord(policyNode, source)
  };
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    return value.find(isRecord);
  }
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const text = cleanText(String(value));
  return text.length > 0 ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function unique<T>(items: Array<T | undefined>): T[] {
  return Array.from(new Set(items.filter((item): item is T => item !== undefined)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
