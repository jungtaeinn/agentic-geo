import { load } from "cheerio";
import { createKeywordClassifier } from "./llm/providers";
import type { AzureRoleDeployments, EmbeddingRuntimeConfig, RerankerRuntimeConfig } from "./llm/types";
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
  type KeywordCategory,
  type OcrExtraction,
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
const IMAGE_OCR_BATCH_SIZE = 10;
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

  const offer = firstObject(productNode?.offers);
  const price = stringValue(offer?.price) ?? clientStateData.price ?? meta($, "product:price:amount") ?? findPrice(bodyText);
  const currency = stringValue(offer?.priceCurrency) ?? clientStateData.currency ?? meta($, "product:price:currency");
  if (price) {
    evidence.push({ field: "product.price", source: offer?.price ? "jsonLd" : "dom", value: price });
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
  appendProductNormalizationDiagnostics(productBaseNormalization, evidence, warnings, runtimeSteps, runtimeOptions);
  process.done("extract", createExtractionNormalizeMessage(productBase.name, "상품 기본정보", productBaseNormalization));

  process.start("ocr", "이미지 OCR과 이미지 대체 텍스트 후보를 문장/키워드 근거로 분류합니다.");
  const ocr = await extractOcrKeywords($, source, productBase.name, productBase.images, runtimeOptions, warnings, runtimeSteps, (message) => {
    process.start("ocr", message);
  });
  const sectionBuckets = createProductSectionBuckets(pageTextBlocks);
  process.done("ocr", `${ocr.imagesScanned}개 이미지 OCR/대체 텍스트 후보에서 OCR 문장과 키워드를 분류했습니다.`);

  process.start("review", "JSON-LD와 리뷰 영역에서 고객 표현을 추출합니다.");
  const reviews = mergeReviewSummaries(extractReviews($, productNode, bodyText), clientStateData.reviews);
  process.done("review", `${reviews.items.length}개 리뷰 근거와 ${reviews.keywords.length}개 리뷰 키워드를 정리했습니다.`);

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

  const resultReviews: ReviewSummary = {
    ...reviews,
    keywords
  };

  if (ocr.imagesScanned === 0 && !hasOcrProviderWarning(warnings)) {
    warnings.push({
      code: "OCR_NO_IMAGE_TEXT",
      message: "No image OCR text candidates were found. Add data-ocr-text fixtures or configure a vision provider for richer extraction."
    });
  }

  const semanticFacts = semanticFactsFromExtraction(product, ocr);
  const ragChunks = await createRagChunks(source, product, resultReviews, ocr, runtimeOptions, runtimeSteps);
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const result: ProductExtractionResult = {
    source,
    sourceType: "url",
    geoProduct: createGeoProductRawData(product, resultReviews, ocr, ragChunks, semanticFacts),
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
    price: stringValue(productSource.price) ?? stringValue(firstVariant?.price) ?? stringValue(firstObject(productSource.offers)?.price),
    currency: stringValue(productSource.currency) ?? stringValue(firstObject(productSource.offers)?.priceCurrency),
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
  const imageTexts = mergeOcrCandidates([
    ...arrayValues(productSource.ocrTexts).map((text, index) => ({
      imageUrl: product.images[index] ?? `${source}#image-${index + 1}`,
      text
    })),
    ...apiTextCandidates
  ]).slice(0, OCR_EVIDENCE_LIMIT);
  const classified = await classifyOcrCandidates(source, product.name, imageTexts, runtimeOptions, warnings, runtimeSteps);
  const ocr: OcrExtraction = {
    imagesScanned: imageTexts.length,
    extractedTexts: imageTexts.map((item) => {
      const keywords = mergeKeywords(
        classified.keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16);

      return {
        ...item,
        confidence: classified.confidence,
        keywords,
        sentenceInsights: sentenceInsightsForCandidate(item, classified.sentenceInsights, keywords, classified.confidence)
      };
    })
  };
  process.done("ocr", `${ocr.imagesScanned}개 OCR 근거 텍스트에서 문장과 키워드를 분류했습니다.`);

  process.start("review", "REST API 리뷰 데이터를 키워드 근거로 정규화합니다.");
  const reviewItems = readReviewArray(reviewSource.items ?? sourceObject.reviewItems);
  const reviews: ReviewSummary = {
    rating: numberValue(reviewSource.rating),
    reviewCount: numberValue(reviewSource.reviewCount),
    items: reviewItems,
    keywords: mergeKeywords(keywordsFromReviews(reviewItems), classified.keywords)
  };
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
  process.done("review", `${reviewItems.length}개 리뷰 항목과 ${reviews.keywords.length}개 키워드를 정리했습니다.`);
  process.start("rag", "API 상품/리뷰/OCR 근거를 RAG chunk로 구성합니다.");
  const semanticFacts = semanticFactsFromExtraction(enrichedProduct, ocr, classified.semanticFacts);
  const ragChunks = await createRagChunks(source, enrichedProduct, reviews, ocr, runtimeOptions, runtimeSteps);
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const result: ProductExtractionResult = {
    source,
    sourceType,
    geoProduct: createGeoProductRawData(enrichedProduct, reviews, ocr, ragChunks, semanticFacts),
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

interface OcrTextCandidate {
  imageUrl: string;
  text: string;
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
    for (const [chunkIndex, chunk] of chunkText(candidateText, 920).entries()) {
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
    .replace(/\s+[–—-]\s+(?:Sulwhasoo|Korean Skincare|Official Store|Official Site).*$/i, "");
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

  return hasProductCareSignal(value) || isReviewEvidenceText(value) || isFaqEvidenceText(value) || isProductMetricEvidenceText(value);
}

function isNonProductCommerceText(text: string): boolean {
  const value = cleanText(text);
  const hardCommercePattern = /(레이어|장바구니|구매하기|바로구매|제품 수량|상품 수량|수량 감소|수량 증가|총 상품가|혜택 적용가|네이버페이|뷰티포인트|적립 제외|사용 제외|재입고|알림 신청|레이어 닫기|판매자 정보|상품정보제공 고시|배송\/교환\/반품|배송지역|배송기간|배송비|교환\/반품|반품\/교환|청약철회|고객센터|택배기사|회수 상품|반송 주소|구매안전서비스|에스크로|KG이니시스|무료배송|첫 구매 혜택|혜택보기|cart|checkout|shipping|returns?|refund|subscribe|newsletter)/i;
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

  const maxLength = category === "ingredient" ? 1100 : 420;
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

function extractReviews($: ReturnType<typeof load>, productNode: Record<string, unknown> | undefined, bodyText: string): ReviewSummary {
  const aggregate = firstObject(productNode?.aggregateRating);
  const jsonLdReviews = readReviewArray(productNode?.review);
  const domReviews = extractDomReviews($);
  const items = mergeReviewItems(jsonLdReviews, domReviews).slice(0, 12);
  const fallbackKeywords = items.length === 0 && (bodyText.toLowerCase().includes("review") || bodyText.includes("리뷰"))
    ? keywordsFromText(bodyText, "review")
    : [];

  return {
    rating: numberValue(aggregate?.ratingValue) ?? extractDomRating($),
    reviewCount: numberValue(aggregate?.reviewCount) ?? extractDomReviewCount($),
    items,
    keywords: mergeKeywords(keywordsFromReviews(items), fallbackKeywords)
  };
}

function extractDomReviews($: ReturnType<typeof load>): ReviewItem[] {
  const reviewSelectors = [
    "[itemprop='review']",
    "[typeof*='Review']",
    "[data-review]",
    "[data-testid*='review']",
    "[class*='review']",
    "[id*='review']"
  ].join(",");
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

async function extractOcrKeywords(
  $: ReturnType<typeof load>,
  source: string,
  productName: string,
  imageUrls: string[],
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  onProgress?: (message: string) => void
): Promise<OcrExtraction> {
  const visionTargets = collectImageOcrTargets($, source, imageUrls, productName);
  const visionOcrTexts = await extractVisionOcrCandidates(visionTargets, source, productName, options, warnings, runtimeSteps, onProgress);
  const imageTexts = mergeOcrCandidates([
    ...visionOcrTexts,
    ...collectImageTextCandidates($, source)
  ])
    .filter((item) => isProductEvidenceCandidate("", item.text))
    .slice(0, OCR_EVIDENCE_LIMIT);

  if (imageTexts.length === 0) {
    return { imagesScanned: 0, extractedTexts: [] };
  }

  onProgress?.(`${imageTexts.length}개 OCR 텍스트 후보를 reasoning 모델로 의미 분석/문장/키워드 분류 중입니다.`);
  const classified = await classifyOcrCandidates(source, productName, imageTexts, options, warnings, runtimeSteps);

  return {
    imagesScanned: imageTexts.length,
    extractedTexts: imageTexts.map((item) => {
      const keywords = mergeKeywords(
        classified.keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16);

      return {
        ...item,
        confidence: classified.confidence,
        keywords,
        sentenceInsights: sentenceInsightsForCandidate(item, classified.sentenceInsights, keywords, classified.confidence)
      };
    })
  };
}

async function extractVisionOcrCandidates(
  targets: string[],
  source: string,
  productName: string,
  options: ProductExtractorOptions,
  warnings: AgentWarning[],
  runtimeSteps: RuntimePipelineStep[],
  onProgress?: (message: string) => void
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

  const extractedTexts: OcrTextCandidate[] = [];
  const failures: string[] = [];
  let quotaOrBillingFailure = false;

  for (let index = 0; index < targets.length; index += IMAGE_OCR_BATCH_SIZE) {
    const batch = targets.slice(index, index + IMAGE_OCR_BATCH_SIZE);
    const batchStart = index + 1;
    const batchEnd = Math.min(index + batch.length, targets.length);
    try {
      onProgress?.(`${targets.length}개 OCR 이미지 중 ${batchStart}-${batchEnd}번 이미지를 OCR 모델로 추출 중입니다.`);
      const extracted = await classifier.extractImageTexts({
        source,
        productName,
        imageUrls: batch
      });
      onProgress?.(`${batchStart}-${batchEnd}번 OCR 이미지에서 ${extracted.images.length}개 텍스트 후보를 수신했습니다.`);
      runtimeSteps.push(createModelRuntimeStep("ocr", "OCR/structure extraction", options, "ocr", extracted.usage, `${batch.length} product-detail images sent for visible text extraction.`));

      extractedTexts.push(...extracted.images.map((image) => ({
        imageUrl: image.imageUrl,
        text: normalizeOcrText(image.text)
      })).filter((item) => item.text.length >= 8));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image OCR provider failed.";
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

  const merged = mergeOcrCandidates(extractedTexts);

  if (merged.length === 0 && failures.length === 0) {
    warnings.push({
      code: "IMAGE_OCR_NO_TEXT_EXTRACTED",
      message: `${targets.length} product-detail image OCR candidates were sent to the image OCR provider, but no readable product text was returned. Check image accessibility, OCR model output, or whether the provider can read the target locale.`
    });
  }

  return merged;
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
  runtimeSteps: RuntimePipelineStep[]
): Promise<{ keywords: ClassifiedKeyword[]; sentenceInsights: ClassifiedSentenceInsight[]; semanticFacts?: Partial<GeoSemanticFacts>; confidence: number }> {
  if (imageTexts.length === 0) {
    return { keywords: [], sentenceInsights: [], confidence: 0 };
  }

  try {
    const classifier = createKeywordClassifier(resolveProviderConfig(options));
    const classified = await classifier.classifyKeywords(await createKeywordClassificationRequest(source, productName, imageTexts, options, runtimeSteps));
    runtimeSteps.push(createModelRuntimeStep("final", "Semantic OCR classification/reasoning", options, "reasoning", classified.usage, `${imageTexts.length} OCR text candidates semantically classified.`));
    const sentenceInsights = imageTexts.flatMap((item) =>
      sentenceInsightsForCandidate(
        item,
        classified.sentenceInsights ?? [],
        mergeKeywords(
          classified.keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())),
          keywordsFromTextAcrossCategories(item.text, "ocr")
        ).slice(0, 16),
        0.72
      )
    );

    return {
      keywords: classified.keywords,
      sentenceInsights: mergeSentenceInsights(sentenceInsights),
      semanticFacts: classified.semanticFacts,
      confidence: 0.72
    };
  } catch (error) {
    runtimeSteps.push(createModelRuntimeStep(
      "final",
      "Semantic OCR classification/reasoning",
      options,
      "reasoning",
      undefined,
      `OCR text classification was called for ${imageTexts.length} candidates but failed: ${error instanceof Error ? error.message : "OCR keyword provider failed."}`
    ));
    warnings.push({
      code: "OCR_PROVIDER_FAILED",
      message: error instanceof Error ? error.message : "OCR keyword provider failed."
    });
    const keywords = mergeKeywords(...imageTexts.map((item) => keywordsFromTextAcrossCategories(item.text, "ocr")));
    return {
      keywords,
      sentenceInsights: imageTexts.flatMap((item) =>
        sentenceInsightsForCandidate(
          item,
          [],
          mergeKeywords(keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())), keywordsFromTextAcrossCategories(item.text, "ocr")),
          0.54
        )
      ),
      confidence: 0.54
    };
  }
}

function sentenceInsightsForCandidate(
  candidate: OcrTextCandidate,
  providerInsights: ClassifiedSentenceInsight[],
  keywords: ClassifiedKeyword[],
  confidence: number
): ClassifiedSentenceInsight[] {
  const providerMatches = providerInsights
    .map(normalizeProviderSentenceInsight)
    .filter((insight): insight is ClassifiedSentenceInsight => Boolean(insight))
    .filter((insight) => providerSentenceInsightBelongsToCandidate(insight, candidate, keywords));
  const localInsights = extractSentenceInsightsFromText(candidate.text, keywords, confidence);
  const localBackfill = providerMatches.length > 0
    ? localInsights.filter((insight) => shouldKeepLocalSentenceBackfill(insight, providerMatches))
    : localInsights;

  return mergeSentenceInsights(providerMatches, localBackfill).slice(0, 8);
}

function extractSentenceInsightsFromText(
  text: string,
  keywords: ClassifiedKeyword[],
  confidence: number
): ClassifiedSentenceInsight[] {
  return splitEvidenceSentences(text).flatMap((sentence): ClassifiedSentenceInsight[] => {
    const sentenceKeywords = mergeKeywords(
      keywords.filter((keyword) => includesKeyword(sentence, keyword.keyword)),
      keywordsFromTextAcrossCategories(sentence, "ocr")
    ).filter((keyword) => keyword.category !== "unknown");
    const category = inferSentenceInsightCategory(sentence, sentenceKeywords);

    if (!category || category === "unknown" || !isSentenceInsightValue(sentence, category)) {
      return [];
    }

    return [{
      text: trimSentenceInsight(sentence, category),
      category,
      keywords: unique(sentenceKeywords.map((keyword) => keyword.keyword)).slice(0, 10),
      confidence,
      source: "ocr"
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
    semanticFacts: insight.semanticFacts
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
    ...candidateKeywords.map((keyword) => keyword.keyword).filter((keyword) => insight.text.toLowerCase().includes(keyword.toLowerCase()))
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

function splitEvidenceSentences(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => cleanText(stripSourceSectionLabel(line)))
    .filter(Boolean);
  const semanticUnits = reconstructOcrSemanticUnits(lines);
  const candidates = semanticUnits.flatMap(segmentSemanticUnit);

  return unique(candidates
    .map((value) => stripSourceSectionLabel(value.replace(/\s+/g, " ")))
    .filter((value) => value.length >= 12)
    .filter((value) => !isLikelyStandaloneOcrHeading(value))
    .filter((value) => value.split(/\s+/).length >= 3 || /[가-힣ぁ-んァ-ン]/.test(value)))
    .slice(0, 12);
}

function reconstructOcrSemanticUnits(lines: string[]): string[] {
  const units: string[] = [];
  let current = "";

  for (const line of lines) {
    if (!line || isLikelyStandaloneOcrHeading(line)) {
      if (current) {
        units.push(current);
        current = "";
      }
      continue;
    }

    if (!current) {
      current = line;
      continue;
    }

    if (startsNewOcrSemanticUnit(current, line)) {
      units.push(current);
      current = line;
      continue;
    }

    current = joinOcrContinuation(current, line);
  }

  if (current) {
    units.push(current);
  }

  return unique(units.map(cleanText).filter((unit) => unit.length >= 12));
}

function startsNewOcrSemanticUnit(current: string, next: string): boolean {
  if (isFullIngredientLabel(next)) {
    return true;
  }
  if (isFullIngredientLabel(current)) {
    return false;
  }
  if (isLikelyStandaloneOcrHeading(next)) {
    return true;
  }
  if (shouldContinueOcrLine(current, next)) {
    return false;
  }

  return /[.!?。！？]$/.test(current) && /^[A-Z가-힣ぁ-んァ-ン0-9]/.test(next);
}

function shouldContinueOcrLine(current: string, next: string): boolean {
  const previousWords = current.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const previousTail = previousWords.at(-1) ?? "";
  const previousTwoWords = previousWords.slice(-2).join(" ");
  const nextHead = nextWords[0] ?? "";

  if (current.endsWith("-")) {
    return true;
  }
  if (/^[a-z]/.test(nextHead)) {
    return true;
  }
  if (/(?:,|:|;|\(|\[|with|and|or|of|for|to|that|which|by|from|in|on|as|is|are|was|were|into|using|including|combines?|contains?|supports?|helps?|working|enhances?)$/i.test(previousTail)
    || /(?:a|an|the|a potent|5 other)$/i.test(previousTwoWords)) {
    return true;
  }
  if (/^(?:and|or|with|that|which|while|working|helping|to|for|of|in|by|as|from|into|plus|including|containing)\b/i.test(next)) {
    return true;
  }
  if (!/[.!?。！？]$/.test(current) && !isLikelyStandaloneOcrHeading(next)) {
    return true;
  }

  return false;
}

function joinOcrContinuation(current: string, next: string): string {
  if (current.endsWith("-")) {
    return `${current.slice(0, -1)}${next}`;
  }
  return `${current} ${next}`;
}

function segmentSemanticUnit(value: string): string[] {
  const cleaned = cleanText(value);
  const sentences = cleaned
    .split(/(?<=[.!?。！？])\s+(?=[A-Z0-9"“‘'가-힣ぁ-んァ-ン])/)
    .map(cleanText)
    .filter((item) => item.length >= 12);

  return sentences.length > 0 ? sentences : [cleaned];
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

  return /(사용\s*(?:전|직후|후)|사용\s+\d|before use|after use|immediately after use|after\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?))/i.test(text)
    && /(결과|개선|효과|측정|수분|보습|장벽|피부결|탄력|주름|%|\d|clinical|result|improv|hydration|moisture|barrier|texture|firmness|wrinkle)/i.test(text)
    && !/(사용법|사용 방법|사용방법|도포|바르|펴 발라|적당량|펌프|펌핑|흡수시켜|apply|dispense|massage|rinse|routine)/i.test(text);
}

function isUsageInstructionSentence(value: string): boolean {
  const text = cleanText(value);

  return /(how to use|directions?|apply|dispense|massage|rinse|morning|night|routine|pump|drops?|사용법|사용 방법|사용방법|도포|바르|펴 발라|적당량|펌프|펌핑|아침|저녁|루틴|흡수시켜|朝|夜)/i.test(text)
    && !isMeasurementTimelineSentence(text);
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
    return isSemanticFieldValue(text, "metric") || /(clinical|result|agreed|showed|after\s+\d)/i.test(text);
  }
  if (category === "faq" || category === "review") {
    return true;
  }

  return isSemanticFieldValue(text, category);
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
  if (isFullIngredientLabel(text)) {
    return true;
  }

  const commaCount = (text.match(/,/g) ?? []).length;
  if (commaCount < 8) {
    return false;
  }

  const matches = text.match(/\b(?:water|aqua|eau|glycerin|glycol|sodium|potassium|cocoyl|cocoate|betaine|acrylates?|peg-\d+|chloride|edta|extract|fragrance|parfum|limonene|benzoate|hydroxide|caprylyl|capryl|citrus|niacinamide|retinol|panthenol|ceramide|hyaluronic|butylene)\b/gi) ?? [];
  return new Set(matches.map((match) => match.toLowerCase())).size >= 5;
}

function sentenceBelongsToCandidate(sentence: string, candidateText: string): boolean {
  const sentenceKey = normalizeFingerprint(sentence);
  const candidateKey = normalizeFingerprint(candidateText);

  if (sentenceKey.length < 12 || candidateKey.length < 12) {
    return false;
  }

  return candidateKey.includes(sentenceKey.slice(0, 120)) || sentenceKey.includes(candidateKey.slice(0, 120));
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
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

  return {
    benefits: semanticFieldValues(buckets.benefits, "benefit", 12),
    effects: semanticFieldValues(buckets.effects, "effect", 12),
    ingredients: semanticFieldValues(buckets.ingredients, "ingredient", 16),
    usage: semanticFieldValues(buckets.usage, "usage", 12),
    metrics: unique(buckets.metrics).slice(0, 16),
    sections: []
  };
}

function semanticFactsFromExtraction(product: ProductProfile, ocr: OcrExtraction, modelFacts?: Partial<GeoSemanticFacts>): GeoSemanticFacts {
  const insightFacts = semanticFactsFromSentenceInsights(ocr.extractedTexts.flatMap((item) => item.sentenceInsights));
  return mergeSemanticFacts({
    ingredients: product.ingredients,
    benefits: product.benefits,
    effects: product.effects,
    skinTypes: [],
    usageSteps: product.usage,
    metricClaims: product.metrics.map((sentence) => ({ sentence, sourceText: sentence })),
    evidenceSentences: [],
    ingredientBenefitLinks: []
  }, insightFacts, modelFacts);
}

function semanticFactsFromSentenceInsights(insights: ClassifiedSentenceInsight[]): GeoSemanticFacts {
  return mergeSemanticFacts(...insights.map((insight): Partial<GeoSemanticFacts> => ({
    ingredients: insight.category === "ingredient" ? semanticKeywordOrSentenceValues(insight) : [],
    benefits: insight.category === "benefit" ? [insight.text] : [],
    effects: insight.category === "effect" ? [insight.text] : [],
    skinTypes: extractSkinTypeSignals(insight.text),
    usageSteps: insight.category === "usage" ? [insight.text] : [],
    metricClaims: insight.category === "metric" || hasMetricSignal(insight.text) ? [{ sentence: insight.text, sourceText: insight.text }] : [],
    evidenceSentences: [insight.text],
    ingredientBenefitLinks: insight.category === "ingredient" && hasBenefitOrEffectLanguage(insight.text)
      ? [{ sentence: insight.text, sourceText: insight.text }]
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
    usageSteps: unique(items.flatMap((item) => arrayValues(item?.usageSteps)).map(cleanText)).slice(0, 12),
    metricClaims: uniqueSemanticMetricClaims(items.flatMap((item) => Array.isArray(item?.metricClaims) ? item.metricClaims : [])).slice(0, 16),
    evidenceSentences: unique(items.flatMap((item) => arrayValues(item?.evidenceSentences)).map(cleanText)).slice(0, 24),
    ingredientBenefitLinks: uniqueSemanticIngredientBenefitLinks(items.flatMap((item) => Array.isArray(item?.ingredientBenefitLinks) ? item.ingredientBenefitLinks : [])).slice(0, 16)
  };
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
      period: stringValue(value.period),
      sample: stringValue(value.sample),
      method: stringValue(value.method),
      caveat: stringValue(value.caveat),
      sentence: stringValue(value.sentence),
      sourceText: stringValue(value.sourceText)
    };
    const key = normalizeFingerprint([
      claim.label,
      claim.subject,
      claim.value,
      claim.metric,
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
      sourceText: stringValue(value.sourceText)
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

function extractSkinTypeSignals(value: string): string[] {
  const text = cleanText(value);
  return unique([
    text.match(/(?:dry|sensitive|oily|combination)\s+skin/gi)?.join(", "),
    text.match(/(?:건조|건성|민감|지성|복합성)\s*피부/g)?.join(", ")
  ].filter((item): item is string => Boolean(item))
    .flatMap((item) => item.split(/\s*,\s*/)));
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
      imageUrl: item.imageUrl,
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

function mergeOcrCandidates(candidates: OcrTextCandidate[]): OcrTextCandidate[] {
  const seen = new Set<string>();
  const merged: OcrTextCandidate[] = [];

  for (const candidate of candidates) {
    const text = normalizeOcrText(candidate.text);
    const fingerprint = normalizeFingerprint(text).slice(0, 220);

    if (text.length === 0 || seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    merged.push({
      imageUrl: candidate.imageUrl,
      text
    });
  }

  return merged.sort((a, b) => scoreProductText(b.text, "") - scoreProductText(a.text, "") || b.text.length - a.text.length);
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
  semanticFacts: GeoSemanticFacts
): GeoProductRawData {
  const productOcrEvidence = ocr.extractedTexts.filter((item) => isProductEvidenceCandidate("", item.text));
  const ocrTexts = unique(productOcrEvidence.map((item) => item.text));
  const ocrSentenceInsights = toGeoSentenceInsights(productOcrEvidence);
  const ocrSentenceSignals = createSentenceSignalBuckets(productOcrEvidence.flatMap((item) => item.sentenceInsights));
  const productTexts = [
    product.name,
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
  const benefits = semanticFieldValues([...product.benefits, ...ocrSentenceSignals.benefits], "benefit", 12);
  const effects = semanticFieldValues([...product.effects, ...ocrSentenceSignals.effects], "effect", 12);
  const ingredients = semanticFieldValues([...product.ingredients, ...ocrSentenceSignals.ingredients], "ingredient", 16);
  const usage = semanticFieldValues([...product.usage, ...ocrSentenceSignals.usage], "usage", 16);
  const reviewKeywords = unique([
    ...reviews.keywords.map((keyword) => keyword.keyword),
    ...reviews.items.flatMap((item) => keywordsFromText(item.body, "review").map((keyword) => keyword.keyword))
  ]).slice(0, 24);
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
    price: product.price
      ? {
          raw: product.price,
          amount: priceAmount(product.price),
          currency: product.currency
        }
      : undefined,
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
            text: item.text
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
  category: "benefit" | "effect" | "ingredient" | "usage",
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
    return !/^(use|사용|주의|face|neck|얼굴|목)$/i.test(text) && /(도포|사용법|아침|저녁|루틴|펌프|펌핑|스킨케어|apply|morning|night|routine|pump|drops?)/i.test(text);
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
    ingredient: /(ginseng|retinol|niacinamide|peptide|hyaluronic|ceramide|collagen|panax|vitamin|성분|원료|진세노믹스|인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민)/gi,
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
