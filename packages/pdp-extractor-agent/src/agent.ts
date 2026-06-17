import { load } from "cheerio";
import { createKeywordClassifier } from "./llm/providers";
import { defaultProductExtractorRagProfile } from "./rag/default-profile";
import { productExtractorRagManifest } from "./rag/manifest";
import {
  ProductExtractionInputSchema,
  type AgentWarning,
  type ClassifiedKeyword,
  type ExtractionEvidence,
  type FaqItem,
  type GeoKeywordGroups,
  type GeoProductRawData,
  type OcrExtraction,
  type ProductContentCategory,
  type ProductContentSection,
  type ProductExtractionInput,
  type ProductExtractionRun,
  type ProductExtractionResult,
  type ProductExtractionStageId,
  type ProductExtractionStep,
  type ProductProfile,
  type RagChunk,
  type ReviewItem,
  type ReviewSummary
} from "./types";

/** Options for swapping model providers without changing the public input contract. */
export interface ProductExtractorOptions {
  provider?: ProductExtractionInput["aiProvider"];
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
  }>;
  onProgress?: (step: ProductExtractionStep) => void;
}

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
    title: "OCR 키워드 분류",
    description: "이미지/상세 영역의 효능, 효과, 성분 키워드 분류"
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
  ]).slice(0, 28);

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
    evidence.push({ field: "page.scrollSections", source: "dom", value: `${pageTextBlocks.length} long-scroll product text sections collected for OCR/RAG.` });
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
    ...$("img").toArray().map((node) => absoluteUrl($(node).attr("src"), source))
  ].filter(Boolean));

  const faq = extractFaq($, faqNode);
  const productBase: ProductProfile = {
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
  process.done("extract", `${name} 상품 기본정보를 정규화했습니다.`);

  process.start("ocr", "이미지 대체 텍스트와 OCR 후보 텍스트를 키워드로 분류합니다.");
  const ocr = await extractOcrKeywords($, source, name, pageTextBlocks, runtimeOptions, warnings);
  const sectionBuckets = createProductSectionBuckets(pageTextBlocks, ocr);
  process.done("ocr", `${ocr.imagesScanned}개 이미지/스크롤 섹션 후보에서 OCR 키워드를 분류했습니다.`);

  process.start("review", "JSON-LD와 리뷰 영역에서 고객 표현을 추출합니다.");
  const reviews = mergeReviewSummaries(extractReviews($, productNode, bodyText), clientStateData.reviews);
  process.done("review", `${reviews.items.length}개 리뷰 근거와 ${reviews.keywords.length}개 리뷰 키워드를 정리했습니다.`);

  process.start("rag", "상품, 리뷰, FAQ, OCR 근거를 RAG chunk로 구성합니다.");
  const keywords = mergeKeywords(reviews.keywords, ocr.extractedTexts.flatMap((item) => item.keywords));

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
      ...fallbackBenefitKeywords
    ]).slice(0, 12),
    effects: unique([
      ...sectionBuckets.effects,
      ...fallbackEffectKeywords
    ]).slice(0, 12),
    ingredients: sectionBuckets.ingredients,
    usage: unique([
      ...sectionBuckets.usage,
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

  const ragChunks = createRagChunks(source, product, resultReviews, ocr, runtimeOptions);
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const result: ProductExtractionResult = {
    source,
    sourceType: "url",
    geoProduct: createGeoProductRawData(product, resultReviews, ocr, ragChunks),
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
  const product: ProductProfile = {
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
  const payloadLabel = sourceType === "url" ? "JSON" : "API";
  process.done("extract", `${product.name} ${payloadLabel} 상품정보를 정규화했습니다.`);

  process.start("ocr", `${payloadLabel}이 제공한 상품 상세 텍스트를 OCR 근거로 분류합니다.`);
  const warnings: AgentWarning[] = [];
  const imageTexts = mergeOcrCandidates([
    ...arrayValues(productSource.ocrTexts).map((text, index) => ({
      imageUrl: product.images[index] ?? `${source}#image-${index + 1}`,
      text
    })),
    ...apiTextCandidates
  ]).slice(0, 18);
  const classified = await classifyOcrCandidates(source, product.name, imageTexts, runtimeOptions, warnings);
  const ocr: OcrExtraction = {
    imagesScanned: imageTexts.length,
    extractedTexts: imageTexts.map((item) => ({
      ...item,
      confidence: classified.confidence,
      keywords: mergeKeywords(
        classified.keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())),
        keywordsFromTextAcrossCategories(item.text, "ocr")
      ).slice(0, 16)
    }))
  };
  process.done("ocr", `${ocr.imagesScanned}개 OCR 근거 텍스트를 분류했습니다.`);

  process.start("review", "REST API 리뷰 데이터를 키워드 근거로 정규화합니다.");
  const reviewItems = readReviewArray(reviewSource.items ?? sourceObject.reviewItems);
  const reviews: ReviewSummary = {
    rating: numberValue(reviewSource.rating),
    reviewCount: numberValue(reviewSource.reviewCount),
    items: reviewItems,
    keywords: mergeKeywords(keywordsFromReviews(reviewItems), classified.keywords)
  };
  const enrichedProduct: ProductProfile = {
    ...product,
    benefits: unique([
      ...product.benefits,
      ...selectKeywordTexts(mergeKeywords(classified.keywords, keywordsFromText(description ?? "", "benefit")), "benefit")
    ]).slice(0, 12),
    effects: unique([
      ...product.effects,
      ...selectKeywordTexts(mergeKeywords(classified.keywords, keywordsFromText(description ?? "", "effect")), "effect")
    ]).slice(0, 12),
    ingredients: unique([
      ...product.ingredients,
      ...selectKeywordTexts(classified.keywords, "ingredient")
    ]).slice(0, 12),
    usage: unique([
      ...product.usage,
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
  const ragChunks = createRagChunks(source, enrichedProduct, reviews, ocr, runtimeOptions);
  process.done("rag", `${ragChunks.length}개 RAG chunk를 생성했습니다.`);
  process.start("json", "최종 JSON 결과를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  process.done("json", "최종 JSON 결과를 생성했습니다.");

  const evidence: ExtractionEvidence[] = [
    {
      field: sourceType === "url" ? "url.jsonPayload" : "api.payload",
      source: "api",
      value: sourceType === "url" ? "URL returned JSON payload and was normalized." : "REST API payload normalized."
    }
  ];
  const result: ProductExtractionResult = {
    source,
    sourceType,
    geoProduct: createGeoProductRawData(enrichedProduct, reviews, ocr, ragChunks),
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
  const candidates: ProductTextCandidate[] = [
    { value: stringValue(productNode?.name), source: "jsonLd", priority: 78 },
    { value: clientStateData.name, source: "dom", priority: 82 },
    { value: meta($, "og:title"), source: "meta", priority: 92 },
    { value: meta($, "twitter:title"), source: "meta", priority: 90 },
    { value: cleanText($("h1").first().text()), source: "dom", priority: 88 },
    { value: cleanText($("title").first().text()), source: "dom", priority: 84 }
  ];
  const handle = productHandleFromSource(source);
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
    textBlocks: contentSectionsToPageTextBlocks(sections, "client-state").slice(0, 20),
    reviews,
    images: (scopedImages.length > 0 ? scopedImages : unique(productRecords.flatMap((record) => readClientStateImages(record, source)))).slice(0, 28),
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
  if (!/(?:__INITIAL_STATE__|__PRELOADED_STATE__|initialState|productDetail|productInfo|reviewInfo|reviews?)/i.test(scriptText)) {
    return [];
  }

  const states: unknown[] = [];
  const assignmentPatterns = [
    /(?:window\.)?__INITIAL_STATE__\s*=\s*\{/g,
    /(?:window\.)?__PRELOADED_STATE__\s*=\s*\{/g,
    /(?:window\.)?initialState\s*=\s*\{/gi
  ];

  for (const pattern of assignmentPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(scriptText)) !== null) {
      const objectStart = scriptText.indexOf("{", match.index);
      const literal = readBalancedObjectLiteral(scriptText, objectStart);
      const parsed = literal ? parseJsonText(literal) : undefined;
      if (parsed !== undefined) {
        states.push(...expandEmbeddedJsonState(parsed));
      }
    }
  }

  return states;
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
  if (!/<img[\s>]/i.test(html)) {
    return [];
  }

  const $ = load(html);
  return unique($("img").toArray().flatMap((node) => [
    absoluteUrl($(node).attr("src"), source),
    absoluteUrl($(node).attr("data-src"), source),
    absoluteUrl(firstSrcsetUrl($(node).attr("srcset")), source)
  ]).filter(Boolean));
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

function createProductSectionBuckets(pageTextBlocks: PageTextBlock[], ocr: OcrExtraction): ProductSectionBuckets {
  const buckets: ProductSectionBuckets = {
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    sections: []
  };
  const ocrByTitleAndText = new Map(ocr.extractedTexts.map((item) => [normalizeFingerprint(item.text), item]));

  for (const block of pageTextBlocks) {
    const text = stripSectionTitle(block.title, block.text);
    if (!isProductEvidenceCandidate(block.title, text)) {
      continue;
    }

    const ocrEvidence = ocrByTitleAndText.get(normalizeFingerprint(`[${block.title}] ${block.text}`));
    const category = sectionCategory(block.title, text, ocrEvidence?.keywords ?? keywordsFromTextAcrossCategories(text, "ocr"));
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
  pageTextBlocks: PageTextBlock[],
  options: ProductExtractorOptions,
  warnings: AgentWarning[]
): Promise<OcrExtraction> {
  const visionOcrTexts = await extractVisionOcrCandidates($, source, productName, options, warnings);
  const imageTexts = mergeOcrCandidates([
    ...visionOcrTexts,
    ...collectImageTextCandidates($, source),
    ...pageTextBlocks.map((block): OcrTextCandidate => ({
      imageUrl: `${source}#${block.id}`,
      text: cleanText(`[${block.title}] ${block.text}`)
    }))
  ])
    .filter((item) => isProductEvidenceCandidate("", item.text))
    .slice(0, 28);

  if (imageTexts.length === 0) {
    return { imagesScanned: 0, extractedTexts: [] };
  }

  try {
    const classifier = createKeywordClassifier(resolveProviderConfig(options));
    const classified = await classifier.classifyKeywords(createKeywordClassificationRequest(source, productName, imageTexts, options));
    return {
      imagesScanned: imageTexts.length,
      extractedTexts: imageTexts.map((item) => ({
        ...item,
        confidence: 0.72,
        keywords: mergeKeywords(
          classified.keywords.filter((keyword) => item.text.toLowerCase().includes(keyword.keyword.toLowerCase())),
          keywordsFromTextAcrossCategories(item.text, "ocr")
        ).slice(0, 16)
      }))
    };
  } catch (error) {
    warnings.push({
      code: "OCR_PROVIDER_FAILED",
      message: error instanceof Error ? error.message : "OCR keyword provider failed."
    });
    return {
      imagesScanned: imageTexts.length,
      extractedTexts: imageTexts.map((item) => ({
        ...item,
        confidence: 0.54,
        keywords: keywordsFromTextAcrossCategories(item.text, "ocr").slice(0, 16)
      }))
    };
  }
}

async function extractVisionOcrCandidates(
  $: ReturnType<typeof load>,
  source: string,
  productName: string,
  options: ProductExtractorOptions,
  warnings: AgentWarning[]
): Promise<OcrTextCandidate[]> {
  const providerConfig = resolveProviderConfig(options);

  if (providerConfig.provider === "mock") {
    return [];
  }

  const targets = collectImageOcrTargets($, source).slice(0, 10);

  if (targets.length === 0) {
    return [];
  }

  try {
    const classifier = createKeywordClassifier(providerConfig);

    if (!classifier.extractImageTexts) {
      return [];
    }

    const extracted = await classifier.extractImageTexts({
      source,
      productName,
      imageUrls: targets
    });

    return extracted.images.map((image) => ({
      imageUrl: image.imageUrl,
      text: normalizeOcrText(image.text)
    })).filter((item) => item.text.length >= 8);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image OCR provider failed.";
    warnings.push({
      code: isQuotaOrBillingError(message) ? "IMAGE_OCR_QUOTA_EXCEEDED" : "IMAGE_OCR_PROVIDER_FAILED",
      message: isQuotaOrBillingError(message)
        ? "OpenAI image OCR quota exceeded. Check the OpenAI project billing, usage limits, and model access before retrying image OCR."
        : message
    });
    return [];
  }
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
  warnings: AgentWarning[]
): Promise<{ keywords: ClassifiedKeyword[]; confidence: number }> {
  if (imageTexts.length === 0) {
    return { keywords: [], confidence: 0 };
  }

  try {
    const classifier = createKeywordClassifier(resolveProviderConfig(options));
    const classified = await classifier.classifyKeywords(createKeywordClassificationRequest(source, productName, imageTexts, options));
    return { keywords: classified.keywords, confidence: 0.72 };
  } catch (error) {
    warnings.push({
      code: "OCR_PROVIDER_FAILED",
      message: error instanceof Error ? error.message : "OCR keyword provider failed."
    });
    return {
      keywords: mergeKeywords(...imageTexts.map((item) => keywordsFromTextAcrossCategories(item.text, "ocr"))),
      confidence: 0.54
    };
  }
}

function createKeywordClassificationRequest(
  source: string,
  productName: string,
  imageTexts: OcrTextCandidate[],
  options: ProductExtractorOptions
) {
  return {
    source,
    productName,
    imageTexts,
    analysisPrompt: options.analysisPrompt,
    ragDocuments: options.ragDocuments
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
        element.attr("data-text"),
        element.attr("alt"),
        element.attr("title"),
        element.attr("aria-label"),
        textAroundImage($, node)
      ].filter(Boolean).join("\n"));
      return { imageUrl, text };
    })
    .filter((item) => item.text.length >= 12 && scoreProductText(item.text, "") > 0 && isProductEvidenceCandidate("", item.text));
}

function collectImageOcrTargets($: ReturnType<typeof load>, source: string): string[] {
  const candidates = $("img, picture source")
    .toArray()
    .map((node) => {
      const element = $(node);
      const imageUrl = imageUrlFromNode($, node, source);
      const label = cleanText([
        imageUrl,
        element.attr("alt"),
        element.attr("title"),
        element.attr("aria-label"),
        textAroundImage($, node)
      ].filter(Boolean).join(" "));

      return {
        imageUrl,
        score: scoreImageOcrTarget(label)
      };
    })
    .filter((item): item is { imageUrl: string; score: number } =>
      typeof item.imageUrl === "string"
      && /^https?:\/\//i.test(item.imageUrl)
      && !/\.(?:svg|gif)(?:[?#]|$)/i.test(item.imageUrl)
    )
    .sort((a, b) => b.score - a.score);

  return unique(candidates.map((item) => item.imageUrl));
}

function scoreImageOcrTarget(value: string): number {
  const text = value.toLowerCase();
  const strongSignals = [
    /clinical|result|before|after|infographic|ingredient|benefit|efficacy|survey|study/,
    /wrinkle|firm|elastic|texture|radiance|ginseng|retinol|peptide|niacinamide/,
    /use|how-to-use|routine|apply|direction/
  ].filter((pattern) => pattern.test(text)).length * 8;
  const weakSignals = /(product|detail|pdp|brand\.com|sulwhasoo|serum|cream)/i.test(value) ? 3 : 0;
  return strongSignals + weakSignals;
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
  const element = $(node);
  const srcset = element.attr("srcset") ?? element.attr("data-srcset");
  return absoluteUrl(
    element.attr("src") ??
      element.attr("data-src") ??
      element.attr("data-original") ??
      element.attr("data-zoom") ??
      firstSrcsetUrl(srcset),
    source
  );
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset?.split(",").map((item) => item.trim().split(/\s+/)[0]).find(Boolean);
}

function textAroundImage($: ReturnType<typeof load>, node: CheerioInput): string {
  const element = $(node);
  const figureText = cleanText(element.closest("figure").find("figcaption").first().text());
  const parentText = cleanText(element.parent().text());
  return [figureText, parentText].filter((text) => text.length > 0).join(" ").slice(0, 520);
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

function createRagChunks(
  source: string,
  product: ProductProfile,
  reviews: ReviewSummary,
  ocr: OcrExtraction,
  options: ProductExtractorOptions
): RagChunk[] {
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

  for (const [index, document] of (options.ragDocuments ?? []).entries()) {
    chunks.push({
      id: `rag-profile-file-${index + 1}`,
      kind: "source",
      text: document.content.slice(0, 12000),
      metadata: { source, documentName: document.name }
    });
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
}

function createGeoProductRawData(
  product: ProductProfile,
  reviews: ReviewSummary,
  ocr: OcrExtraction,
  ragChunks: RagChunk[]
): GeoProductRawData {
  const productOcrEvidence = ocr.extractedTexts.filter((item) => isProductEvidenceCandidate("", item.text));
  const ocrTexts = unique(productOcrEvidence.map((item) => item.text));
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
  ]).slice(0, 32);
  const ratingSummary = createRatingSummary(reviews);
  const benefits = semanticFieldValues(product.benefits, "benefit", 12);
  const effects = semanticFieldValues(product.effects, "effect", 12);
  const ingredients = semanticFieldValues(product.ingredients, "ingredient", 16);
  const usage = semanticFieldValues(product.usage, "usage", 16);
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
        textBlocks: ocrTexts.slice(0, 24)
      }
    },
    aiAnalysis: {
      keywords: keywordGroups,
      categorizedSections: contentSections,
      summary: createAiAnalysisSummary(categorizedProductInfo, reviews, ocr)
    },
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
      textBlocks: ocrTexts.slice(0, 24),
      keywords: keywordGroups
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
    apiVersion: options.apiVersion
  };
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
