import type {
  PdpGeoLocale,
  PdpGeoRagFieldTarget,
  PdpGeoRagChunk,
  PdpGeoRagIntent,
  PdpGeoRagQueryPlan,
  PdpGeoRagSettings,
  PdpGeoRagSubquery,
  PdpGeoRagUpdateTarget,
  PdpGeoRagUrlResolvedDocument,
  PdpGeoRagUrlResolver,
  PdpGeoRetrievedChunk,
  PdpGeoRetriever,
  PdpGeoRetrieverRequest,
  PdpProductSignal
} from "../types";
import {
  findPdpGeoRagIndexEntry,
  findPdpGeoRagSectionEntry
} from "./rag-index";

export interface RetrievePdpGeoRagChunksOptions {
  apiKey?: string;
  customRetriever?: PdpGeoRetriever;
  urlResolver?: PdpGeoRagUrlResolver;
}

/** Resolves user/runtime RAG settings into explicit provider choices. */
export function resolvePdpGeoRagSettings(settings: PdpGeoRagSettings = {}): Required<Pick<PdpGeoRagSettings, "mode" | "provider" | "embeddingProvider" | "rerankerProvider">> & PdpGeoRagSettings {
  const mode = settings.mode ?? "local-versioned-rag";
  const provider = settings.provider ?? (mode === "managed-vector-store-rag" ? "openai" : "local");
  const embeddingProvider = settings.embeddingProvider ?? (mode === "managed-vector-store-rag" ? provider === "openai" ? "openai" : "custom" : "local");
  const rerankerProvider = settings.rerankerProvider ?? (mode === "managed-vector-store-rag" && provider === "openai" ? "openai-file-search" : "local-hybrid");

  return {
    ...settings,
    mode,
    provider,
    embeddingProvider,
    rerankerProvider,
    maxChunks: settings.maxChunks ?? 8,
    scoreThreshold: settings.scoreThreshold ?? 0.08,
    rewriteQuery: settings.rewriteQuery ?? true
  };
}

/** Retrieves RAG chunks through either local versioned files or a managed vector store provider. */
export async function retrievePdpGeoRagChunks(
  request: Omit<PdpGeoRetrieverRequest, "settings"> & { settings: ReturnType<typeof resolvePdpGeoRagSettings> },
  options: RetrievePdpGeoRagChunksOptions = {}
): Promise<PdpGeoRetrievedChunk[]> {
  if (request.settings.mode === "managed-vector-store-rag") {
    if (request.settings.provider === "custom") {
      if (!options.customRetriever) {
        throw new Error("A customRetriever is required when rag.provider is custom.");
      }
      return options.customRetriever.retrieve(request);
    }
    if (request.settings.provider === "openai") {
      return new OpenAiVectorStoreRetriever(options.apiKey).retrieve(request);
    }
  }

  const documents = await resolveReferencedUrlDocuments(request.documents, request.settings, options.urlResolver);
  return new LocalVersionedRagRetriever().retrieve({
    ...request,
    documents
  });
}

/** Builds the retrieval query from normalized product signals and generation context. */
export function createPdpGeoRagQuery(product: PdpProductSignal, locale: PdpGeoLocale, market?: string): string {
  return [
    `Generate PDP GEO schema and content for ${product.name}.`,
    product.brand ? `Brand: ${product.brand}.` : undefined,
    product.category ? `Category: ${product.category}.` : undefined,
    `Locale: ${locale}. Market: ${market ?? "unknown"}.`,
    product.benefits.length > 0 ? `Benefits: ${product.benefits.slice(0, 5).join(", ")}.` : undefined,
    product.ingredients.length > 0 ? `Ingredients: ${product.ingredients.slice(0, 5).join(", ")}.` : undefined,
    product.usage.length > 0 ? `Usage: ${product.usage.slice(0, 3).join(", ")}.` : undefined,
    product.reviews.keywords.length > 0 ? `Review keywords: ${product.reviews.keywords.slice(0, 6).join(", ")}.` : undefined,
    "Need schema.org Product FAQPage HowTo BreadcrumbList WebPage, E-E-A-T, CEP, GEO, locale terminology, additionalProperty, positiveNotes.",
    "Need OCR sentence diagnostics, answer-ready FAQ intent, positive or neutral customer review FAQ intent, WebPage/Product description separation, source-supported benefit/effect wording, source-faithful HowTo eligibility, and public wording without internal diagnostic labels.",
    "Product.description order: product introduction and type -> target customer and concrete concern/CEP -> ingredient and formula composition -> supported finished-product benefits/effects -> source-stated research/article citation -> concise attributed review keywords last. Keep directions out of Product.description.",
    "WebPage.description uses page-scope language and Product.description uses product-entity language, but both follow the evidence order product introduction -> target customer -> composition -> benefit/effect -> source-stated research/article citation -> attributed review keywords last. Preserve cited dates and numbers exactly while rendering them naturally. HowTo requires at least one concrete source action: one source instruction becomes one step, while multiple steps require an explicitly ordered source sequence. Customer-review usage anecdotes are never HowTo evidence.",
    "Use official OpenAI, Google Search Central, Gemini, and Perplexity docs for retrieval mode, embeddings, grounding, structured data, and answer-ready source support guidance."
  ].filter(Boolean).join("\n");
}

export function createPdpGeoRagQueryPlan(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  market: string | undefined,
  settings: Pick<PdpGeoRagSettings, "queryPlanning"> = {},
  hintUpdateTargets: PdpGeoRagUpdateTarget[] = []
): PdpGeoRagQueryPlan {
  const updateTargets = uniqueUpdateTargets([
    ...hintUpdateTargets,
    ...(settings.queryPlanning?.updateTargets ?? [])
  ]);
  const planningEnabled = settings.queryPlanning?.enabled ?? updateTargets.length > 0;
  const baseQuery = createPdpGeoRagQuery(product, locale, market);

  if (!planningEnabled) {
    return {
      mode: "single-query",
      updateTargets: ["general"],
      queries: [createGeneralSubquery(baseQuery)]
    };
  }

  const includeBaseQuery = settings.queryPlanning?.includeBaseQuery ?? true;
  const maxSubqueries = settings.queryPlanning?.maxSubqueries ?? 6;
  const targetQueries = updateTargets.flatMap((target) => createTargetSubquery(target, product, locale, market));
  const queries = [
    includeBaseQuery ? createGeneralSubquery(baseQuery) : undefined,
    ...targetQueries
  ].filter((query): query is PdpGeoRagSubquery => Boolean(query)).slice(0, maxSubqueries);

  return {
    mode: "agentic-subquery-planning",
    updateTargets: queries.map((query) => query.target),
    queries: queries.length > 0 ? queries : [createGeneralSubquery(baseQuery)]
  };
}

function createGeneralSubquery(query: string): PdpGeoRagSubquery {
  return {
    id: "general",
    target: "general",
    query,
    intents: ["schema", "evidence", "retrieval", "general"],
    fieldTargets: ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
    reason: "Full GEO generation requires broad schema, evidence, locale, and public wording context."
  };
}

function createTargetSubquery(
  target: PdpGeoRagUpdateTarget,
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  market?: string
): PdpGeoRagSubquery[] {
  const baseFacts = [
    `Product: ${product.name}.`,
    product.brand ? `Brand: ${product.brand}.` : undefined,
    product.category ? `Category: ${product.category}.` : undefined,
    `Locale: ${locale}. Market: ${market ?? "unknown"}.`
  ].filter(Boolean).join(" ");
  const reviewText = product.reviews.keywords.length > 0 ? `Review keywords: ${product.reviews.keywords.slice(0, 8).join(", ")}.` : "";
  const usageText = product.usage.length > 0 ? `Usage evidence: ${product.usage.slice(0, 5).join(" / ")}.` : "";
  const ingredientText = product.ingredients.length > 0 ? `Ingredients: ${product.ingredients.slice(0, 8).join(", ")}.` : "";
  const benefitText = product.benefits.length > 0 ? `Benefits: ${product.benefits.slice(0, 8).join(", ")}.` : "";

  const map: Record<PdpGeoRagUpdateTarget, PdpGeoRagSubquery> = {
    productDescription: {
      id: "target-product-description",
      target,
      query: `${baseFacts} Update only Product.description with this ordered flow: product introduction and type -> target customer and concrete concern/CEP -> ingredient and formula composition -> supported finished-product benefits/effects -> source-stated research/article citation -> concise attributed customer-review keywords last. Parse cited dates and numbers naturally without changing them. Keep usage separate, preserve E-E-A-T claim safety, and do not infer ingredient-benefit causality from co-occurrence. ${benefitText} ${ingredientText} ${reviewText}`,
      intents: ["claims", "evidence", "customer", "schema"],
      fieldTargets: ["Product.description", "Product.additionalProperty", "Product.positiveNotes"],
      reason: "Product description changed or needs regeneration without broad FAQ/HowTo updates."
    },
    webPageDescription: {
      id: "target-webpage-description",
      target,
      query: `${baseFacts} Update only WebPage.description as a concise page-level counterpart in this order: identify the product page and source-backed brand -> supported target customer -> ingredient/formula composition -> finished-product benefit/effect -> source-stated research/article citation -> attributed review keywords last. Parse cited dates and numbers naturally without changing them. Do not repeat Product.description wording, exact HowTo actions, or raw report-like metric blocks. Keep schema role separation and public wording guardrails. ${benefitText} ${ingredientText} ${reviewText}`,
      intents: ["customer", "claims", "schema"],
      fieldTargets: ["WebPage.description", "PDP.content"],
      reason: "Page-level description changed or needs regeneration while preserving product facts."
    },
    quickFacts: {
      id: "target-quick-facts",
      target,
      query: `${baseFacts} Update quick facts and Product.additionalProperty from source-backed product attributes only. ${benefitText} ${ingredientText} ${usageText}`,
      intents: ["claims", "evidence", "schema"],
      fieldTargets: ["Product.additionalProperty", "PDP.content"],
      reason: "Only factual attribute blocks need refresh."
    },
    benefits: {
      id: "target-benefits",
      target,
      query: `${baseFacts} Update benefit/effect PDP sections and Product.positiveNotes with source-backed claim wording and overclaim filtering. ${benefitText}`,
      intents: ["claims", "evidence", "customer"],
      fieldTargets: ["Product.positiveNotes", "PDP.content", "Product.description"],
      reason: "Benefit/effect copy changed and should not force unrelated FAQ/HowTo regeneration."
    },
    ingredients: {
      id: "target-ingredients",
      target,
      query: `${baseFacts} Update ingredient, formula, additionalProperty, and ingredient-related FAQ context only. ${ingredientText}`,
      intents: ["claims", "evidence", "faq", "schema"],
      fieldTargets: ["Product.additionalProperty", "FAQPage.mainEntity", "PDP.content"],
      reason: "Ingredient information changed and downstream ingredient sections need targeted support."
    },
    howToUse: {
      id: "target-howto",
      target,
      query: `${baseFacts} Update only HowTo.step and how-to-use PDP content from direct source usage. Emit HowTo for a concrete goal plus at least one concrete source action. Preserve count and order: one source instruction becomes exactly one step, while multiple steps require an explicitly numbered or sequential source procedure. Omit multiple unmarked or unordered notes, never infer a routine from action-stage order, and never use customer-review anecdotes as steps. Keep schema.org HowTo compatibility. ${usageText}`,
      intents: ["howTo", "schema", "evidence"],
      fieldTargets: ["HowTo.step", "PDP.content"],
      reason: "Usage instructions changed, so HowTo-specific RAG should be retrieved without broad regeneration."
    },
    faq: {
      id: "target-faq",
      target,
      query: `${baseFacts} Update only FAQPage.mainEntity and FAQ PDP content. Need source-backed answers, ingredient/usage/customer intent, metric evidence, positive or neutral review use-feel FAQ intent, negative review exclusion, and FAQ schema compatibility. ${benefitText} ${ingredientText} ${usageText} ${reviewText}`,
      intents: ["faq", "customer", "review", "schema", "evidence"],
      fieldTargets: ["FAQPage.mainEntity", "PDP.content"],
      reason: "FAQ content changed or needs a targeted refresh."
    },
    schema: {
      id: "target-schema",
      target,
      query: `${baseFacts} Update JSON-LD schema graph fields only: Product, WebPage, FAQPage, HowTo, BreadcrumbList, additionalProperty, positiveNotes, offer/review compatibility, and validation constraints.`,
      intents: ["schema", "evidence"],
      fieldTargets: ["Product.description", "WebPage.description", "FAQPage.mainEntity", "HowTo.step", "BreadcrumbList", "Product.additionalProperty"],
      reason: "Schema markup changed independently from public copy."
    },
    breadcrumbs: {
      id: "target-breadcrumbs",
      target,
      query: `${baseFacts} Update only BreadcrumbList and page hierarchy schema using source URL, brand, category, and product hierarchy evidence.`,
      intents: ["schema"],
      fieldTargets: ["BreadcrumbList"],
      reason: "Navigation or hierarchy changed and only breadcrumb schema needs refresh."
    },
    reviews: {
      id: "target-reviews",
      target,
      query: `${baseFacts} Update positive or neutral review-led product copy, review-intent FAQ use-feel answers, review summaries, and review-backed positive notes. Exclude negative review complaints, scent complaints, rating metadata, and raw reviewer snippets from FAQPage. ${reviewText}`,
      intents: ["review", "faq", "customer", "evidence"],
      fieldTargets: ["FAQPage.mainEntity", "Product.positiveNotes", "Product.description", "PDP.content"],
      reason: "Review signals changed and should update review-dependent GEO content while keeping negative reviews out of public FAQ intent."
    }
  };

  return [map[target]];
}

function uniqueUpdateTargets(values: PdpGeoRagUpdateTarget[]): PdpGeoRagUpdateTarget[] {
  return Array.from(new Set(values));
}

export class LocalVersionedRagRetriever implements PdpGeoRetriever {
  async retrieve(request: PdpGeoRetrieverRequest): Promise<PdpGeoRetrievedChunk[]> {
    const chunks = request.documents.flatMap((document) => chunkDocument(document.name, document.content, document.version));
    const queryEmbedding = embedText(request.query);
    const queryTerms = tokenize(request.query);
    const scoredCandidates = chunks.map((chunk) => {
      const contextualText = createContextualRetrievalText(chunk);
      const lexicalScore = lexicalSimilarity(queryTerms, tokenize(contextualText));
      const semanticScore = cosineSimilarity(queryEmbedding, embedText(contextualText));
      const boost = retrievalBoost(chunk, request.locale, request.market);

      return {
        chunk,
        lexicalScore,
        semanticScore,
        boost
      };
    });
    const lexicalRanks = rankCandidates(scoredCandidates, (candidate) => candidate.lexicalScore);
    const semanticRanks = rankCandidates(scoredCandidates, (candidate) => candidate.semanticScore);
    const scored = scoredCandidates.map((candidate, index) => {
      const rrfHybridScore = reciprocalRankFusionScore([
        lexicalRanks.get(index) ?? scoredCandidates.length,
        semanticRanks.get(index) ?? scoredCandidates.length
      ]);
      const score = clamp((candidate.lexicalScore * 0.38) + (candidate.semanticScore * 0.34) + (rrfHybridScore * 0.16) + candidate.boost, 0, 1);

      return {
        ...candidate.chunk,
        metadata: {
          ...candidate.chunk.metadata,
          contextualRetrieval: true,
          lexicalScore: roundScore(candidate.lexicalScore),
          semanticScore: roundScore(candidate.semanticScore),
          rrfHybridScore: roundScore(rrfHybridScore),
          retrievalBoost: roundScore(candidate.boost)
        },
        score
      };
    });
    const reranked = rerankLocalChunks(scored, request);

    return reranked
      .filter((chunk) => chunk.score >= (request.settings.scoreThreshold ?? 0.08))
      .slice(0, request.settings.maxChunks ?? 8);
  }
}

function rankCandidates<T>(candidates: T[], getScore: (candidate: T) => number): Map<number, number> {
  const ranked = candidates
    .map((candidate, index) => ({ index, score: getScore(candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const ranks = new Map<number, number>();

  ranked.forEach((candidate, index) => {
    ranks.set(candidate.index, index + 1);
  });

  return ranks;
}

function reciprocalRankFusionScore(ranks: number[]): number {
  const k = 60;
  return clamp(ranks.reduce((score, rank) => score + (1 / (k + rank)), 0) * 30, 0, 1);
}

export class OpenAiVectorStoreRetriever implements PdpGeoRetriever {
  constructor(private readonly apiKey?: string) {}

  async retrieve(request: PdpGeoRetrieverRequest): Promise<PdpGeoRetrievedChunk[]> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for managed-vector-store-rag with the OpenAI provider.");
    }
    if (!request.settings.vectorStoreId) {
      throw new Error("rag.vectorStoreId is required for managed-vector-store-rag with the OpenAI provider.");
    }

    const endpoint = request.settings.managedSearchEndpoint ?? `https://api.openai.com/v1/vector_stores/${request.settings.vectorStoreId}/search`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: request.query,
        max_num_results: request.settings.maxChunks ?? 8,
        rewrite_query: request.settings.rewriteQuery ?? true
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI vector store search failed: ${response.status}${await responseErrorSuffix(response)}`);
    }

    const payload = await response.json() as {
      data?: Array<{
        filename?: string;
        score?: number;
        attributes?: Record<string, string | number | boolean>;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };

    return (payload.data ?? []).flatMap((item, index): PdpGeoRetrievedChunk[] => {
      const text = (item.content ?? []).map((content) => content.text).filter(Boolean).join("\n").trim();
      if (!text) {
        return [];
      }

      const kind = kindFromName(item.filename ?? "custom");
      const routing = inferRagChunkRouting(kind, item.filename ?? "openai-vector-store", undefined, text);

      return [{
        id: `openai-vector-${index + 1}`,
        source: item.filename ?? "openai-vector-store",
        text,
        kind,
        intents: routing.intents,
        fieldTargets: routing.fieldTargets,
        metadata: {
          ...(item.attributes ?? {}),
          sectionIntents: routing.intents.join(","),
          fieldTargets: routing.fieldTargets.join(",")
        },
        score: typeof item.score === "number" ? item.score : 0
      }];
    });
  }
}

function chunkDocument(name: string, content: string, version = "v1"): PdpGeoRagChunk[] {
  const sections = splitMarkdownSections(content);
  return sections.map((section, index) => {
    const indexedDocument = findPdpGeoRagIndexEntry(name);
    const indexedSection = findPdpGeoRagSectionEntry(name, section.title);
    const kind = indexedDocument?.kind ?? kindFromName(name);
    const inferredRouting = inferRagChunkRouting(kind, name, section.title, section.text);
    const routing = {
      intents: indexedSection?.intents ?? indexedDocument?.intents ?? inferredRouting.intents,
      fieldTargets: indexedSection?.fieldTargets ?? indexedDocument?.fieldTargets ?? inferredRouting.fieldTargets
    };

    return {
      id: `${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${index + 1}`,
      source: name,
      title: section.title,
      text: section.text,
      kind,
      intents: routing.intents,
      fieldTargets: routing.fieldTargets,
      metadata: {
        version,
        index,
        managed: true,
        sourceRole: indexedDocument?.sourceRole ?? "custom",
        checkedAt: indexedDocument?.checkedAt ?? "",
        headingPath: section.headingPath ?? section.title ?? "",
        routingPriority: indexedSection?.priority ?? indexedDocument?.priority ?? 0,
        sectionIntents: routing.intents.join(","),
        fieldTargets: routing.fieldTargets.join(",")
      }
    };
  });
}

async function resolveReferencedUrlDocuments(
  documents: PdpGeoRetrieverRequest["documents"],
  settings: ReturnType<typeof resolvePdpGeoRagSettings>,
  customResolver?: PdpGeoRagUrlResolver
): Promise<PdpGeoRetrieverRequest["documents"]> {
  if (!settings.resolveUrls) {
    return documents;
  }

  const maxResolved = settings.maxResolvedUrlDocuments ?? 16;
  const urlReferences = documents.flatMap((document) => extractUrls(document.content).map((url) => ({
    url,
    document
  })));
  const uniqueReferences = uniqueBy(urlReferences, (reference) => reference.url).slice(0, maxResolved);
  if (uniqueReferences.length === 0) {
    return documents;
  }

  const resolver = customResolver ?? new FetchRagUrlResolver(settings);
  const resolvedDocuments: PdpGeoRetrieverRequest["documents"] = [];

  for (const reference of uniqueReferences) {
    const resolved = await resolver.resolve({
      url: reference.url,
      sourceDocumentName: reference.document.name,
      sourceDocumentVersion: reference.document.version
    }).catch(() => undefined);
    if (!resolved?.content.trim()) {
      continue;
    }
    const extraction = extractGeoRelevantUrlContent(resolved);
    if (!extraction.content.trim()) {
      continue;
    }
    resolvedDocuments.push({
      name: resolved.url,
      content: [
        `# ${resolved.title ?? resolved.url}`,
        "",
        `Source URL: ${resolved.url}`,
        `Referenced from: ${reference.document.name}`,
        `Source type: ${extraction.sourceType}`,
        `Extraction reason: ${extraction.reason}`,
        "",
        extraction.content
      ].join("\n"),
      version: reference.document.version ?? "url"
    });
  }

  return [...documents, ...resolvedDocuments];
}

class FetchRagUrlResolver implements PdpGeoRagUrlResolver {
  constructor(private readonly settings: ReturnType<typeof resolvePdpGeoRagSettings>) {}

  async resolve(request: { url: string }): Promise<PdpGeoRagUrlResolvedDocument | undefined> {
    const parsed = safePublicUrl(request.url, this.settings.allowedUrlDomains);
    if (!parsed) {
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.urlFetchTimeoutMs ?? 5000);

    try {
      const response = await fetch(parsed.toString(), {
        headers: {
          Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "agentic-geo-rag-url-resolver/0.1"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        return undefined;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isSupportedUrlContentType(contentType)) {
        return undefined;
      }

      const text = (await response.text()).slice(0, 180_000);
      const title = extractHtmlTitle(text);
      const content = contentType.includes("html") ? htmlToReadableText(text) : text;
      return {
        url: parsed.toString(),
        title,
        content: content.slice(0, 40_000),
        contentType
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

type ResolvedUrlSourceType = "official-paper" | "schema-reference" | "provider-doc" | "official-doc" | "other";

function extractGeoRelevantUrlContent(resolved: PdpGeoRagUrlResolvedDocument): { sourceType: ResolvedUrlSourceType; reason: string; content: string } {
  const sourceType = classifyResolvedUrlSource(resolved.url, resolved.title);
  const sections = splitResolvedTextSections(resolved.content);
  const scored = sections
    .filter((section) => !isResolvedUrlBoilerplate(section))
    .map((section, index) => ({
      section,
      index,
      score: geoRelevanceScore(section, sourceType)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxUrlSectionsForSourceType(sourceType))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.section);
  const fallback = resolved.content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n\n");
  const selected = scored.length > 0 ? scored.join("\n\n") : fallback;

  return {
    sourceType,
    reason: extractionReasonForSourceType(sourceType),
    content: selected.slice(0, maxUrlContentLengthForSourceType(sourceType))
  };
}

function classifyResolvedUrlSource(url: string, title?: string): ResolvedUrlSourceType {
  const key = `${url} ${title ?? ""}`.toLowerCase();
  if (/generative-engines\.com|arxiv\.org|doi\.org|paper|research|proceedings/.test(key)) {
    return "official-paper";
  }
  if (/schema\.org/.test(key)) {
    return "schema-reference";
  }
  if (/developers\.openai\.com|platform\.openai\.com|ai\.google\.dev|docs\.perplexity\.ai/.test(key)) {
    return "provider-doc";
  }
  if (/developers\.google\.com|search central|official/.test(key)) {
    return "official-doc";
  }
  return "other";
}

function splitResolvedTextSections(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return [];
  }
  const markdownSections = splitMarkdownSections(normalized).map((section) => section.text);
  if (markdownSections.length > 1) {
    return markdownSections;
  }
  return normalized
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter((section) => section.length > 80);
}

function geoRelevanceScore(section: string, sourceType: ResolvedUrlSourceType): number {
  const text = section.toLowerCase();
  let score = 0;

  score += keywordScore(text, [
    "generative engine",
    "generative engines",
    "answer engine",
    "citation",
    "cite",
    "visibility",
    "source",
    "grounding",
    "retrieval",
    "structured data",
    "schema.org",
    "product structured data",
    "product snippet",
    "merchant listing",
    "faqpage",
    "howto",
    "breadcrumblist",
    "webpage",
    "product",
    "review",
    "rating",
    "offer",
    "claim",
    "evidence",
    "attribute",
    "property",
    "entity",
    "content optimization",
    "domain-specific"
  ]);

  score -= keywordScore(text, [
    "install",
    "npm",
    "pip install",
    "curl",
    "api key",
    "authentication",
    "rate limit",
    "billing",
    "pricing",
    "sdk",
    "sdks",
    "quickstart",
    "navigation",
    "get started overview",
    "sdk and cli",
    "node reference",
    "prompt guide",
    "early adopters program",
    "package tracking",
    "structured data carousels",
    "profile page q&a recipe",
    "software app",
    "vacation rental",
    "title links",
    "cookie",
    "terms and conditions",
    "login",
    "dashboard"
  ]);

  if (sourceType === "official-paper" && /experiment|benchmark|dataset|method|visibility|citation|domain-specific|generative engine/.test(text)) {
    score += 4;
  }
  if (sourceType === "schema-reference" && /property|expected type|used on these types|values expected|examples|faqpage|howto|product|webpage|breadcrumblist/.test(text)) {
    score += 4;
  }
  if (sourceType === "provider-doc" && /retrieval|embedding|grounding|search result|file search|vector|citation|source/.test(text)) {
    score += 4;
  }
  if (sourceType === "official-doc" && /structured data|product|review|rating|offer|eligibility|required|recommended/.test(text)) {
    score += 4;
  }
  if (text.length < 120) {
    score -= 2;
  }

  return score;
}

function isResolvedUrlBoilerplate(section: string): boolean {
  const text = section.toLowerCase().replace(/\s+/g, " ");
  return [
    "get started overview quickstart models pricing",
    "openai sdk agents sdk openai cli",
    "early adopters program package tracking",
    "profile page q&a recipe review snippet software app",
    "speakable subscription and paywalled content vacation rental",
    "debug drops in search traffic",
    "terms and conditions schema.org",
    "skip to main content"
  ].some((phrase) => text.includes(phrase));
}

function keywordScore(text: string, keywords: string[]): number {
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
}

function maxUrlSectionsForSourceType(sourceType: ResolvedUrlSourceType): number {
  switch (sourceType) {
    case "official-paper":
      return 8;
    case "schema-reference":
      return 6;
    case "provider-doc":
    case "official-doc":
      return 5;
    case "other":
      return 3;
  }
}

function maxUrlContentLengthForSourceType(sourceType: ResolvedUrlSourceType): number {
  switch (sourceType) {
    case "official-paper":
      return 9000;
    case "schema-reference":
      return 7000;
    case "provider-doc":
    case "official-doc":
      return 6000;
    case "other":
      return 3500;
  }
}

function extractionReasonForSourceType(sourceType: ResolvedUrlSourceType): string {
  switch (sourceType) {
    case "official-paper":
      return "GEO research signals such as citation readiness, visibility, source attribution, answer synthesis, and domain-specific optimization.";
    case "schema-reference":
      return "Schema.org type/property compatibility for Product, WebPage, FAQPage, HowTo, and BreadcrumbList generation.";
    case "provider-doc":
      return "Provider retrieval, embedding, search, grounding, and source-evidence mechanics relevant to RAG diagnostics.";
    case "official-doc":
      return "Official structured data eligibility and product evidence guidance relevant to schema and claim generation.";
    case "other":
      return "General GEO-relevant excerpts selected by deterministic relevance scoring.";
  }
}

function extractUrls(content: string): string[] {
  const matches = stripFencedCodeBlocks(content).match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return matches
    .map((url) => url.replace(/[.,;:!?]+$/g, ""))
    .filter((url) => Boolean(safePublicUrl(url)));
}

function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, " ");
}

function safePublicUrl(value: string, allowedDomains?: string[]): URL | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || isBlockedHostname(hostname)) {
      return undefined;
    }
    if (allowedDomains?.length && !allowedDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0") {
    return true;
  }
  if (hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) {
    return true;
  }
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isSupportedUrlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html")
    || normalized.includes("text/plain")
    || normalized.includes("text/markdown")
    || normalized.includes("application/json")
    || normalized.includes("application/xhtml+xml")
    || normalized === "";
}

function extractHtmlTitle(value: string): string | undefined {
  return decodeHtmlEntities(value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
}

function htmlToReadableText(value: string): string {
  const primaryHtml = extractPrimaryHtml(value);
  return decodeHtmlEntities(primaryHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function extractPrimaryHtml(value: string): string {
  const candidates = [
    ...Array.from(value.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi)).map((match) => match[1] ?? ""),
    ...Array.from(value.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)).map((match) => match[1] ?? ""),
    ...Array.from(value.matchAll(/<div\b[^>]*(?:class|id)=["'][^"']*(?:content|docs|article|markdown|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)).map((match) => match[1] ?? "")
  ].map((candidate) => candidate.trim()).filter(Boolean);

  return candidates.sort((a, b) => b.length - a.length)[0] ?? value;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function splitMarkdownSections(content: string): Array<{ title?: string; headingPath?: string; text: string }> {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith("{")) {
    return [{ title: "JSON terminology map", headingPath: "JSON terminology map", text: normalized }];
  }

  const sections: Array<{ title?: string; headingPath?: string; text: string }> = [];
  const lines = normalized.split("\n");
  let title: string | undefined;
  let headingPath: string | undefined;
  let headingTrail: string[] = [];
  let buffer: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (buffer.join("\n").trim()) {
        sections.push({ title, headingPath, text: buffer.join("\n").trim() });
      }
      const level = heading[1]?.length ?? 1;
      title = heading[2]?.trim();
      headingTrail = headingTrail.slice(0, level - 1);
      if (title) {
        headingTrail[level - 1] = title;
      }
      headingPath = headingTrail.filter(Boolean).join(" > ");
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }

  if (buffer.join("\n").trim()) {
    sections.push({ title, headingPath, text: buffer.join("\n").trim() });
  }

  return sections.flatMap((section) => splitLongSection(section));
}

function splitLongSection(section: { title?: string; headingPath?: string; text: string }): Array<{ title?: string; headingPath?: string; text: string }> {
  const maxLength = 1100;
  if (section.text.length <= maxLength) {
    return [section];
  }

  const paragraphs = section.text.split(/\n{2,}/);
  const chunks: Array<{ title?: string; headingPath?: string; text: string }> = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      if (current.trim()) {
        chunks.push({ title: section.title, headingPath: section.headingPath, text: current.trim() });
        current = "";
      }
      chunks.push(...splitLongParagraph(paragraph, maxLength).map((text) => ({ title: section.title, headingPath: section.headingPath, text })));
      continue;
    }

    if ((current + "\n\n" + paragraph).length > maxLength && current.trim()) {
      chunks.push({ title: section.title, headingPath: section.headingPath, text: current.trim() });
      current = paragraph;
    } else {
      current = [current, paragraph].filter(Boolean).join("\n\n");
    }
  }

  if (current.trim()) {
    chunks.push({ title: section.title, headingPath: section.headingPath, text: current.trim() });
  }

  return chunks;
}

function splitLongParagraph(paragraph: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph.trim();

  while (remaining.length > maxLength) {
    const preferredWindowStart = Math.floor(maxLength * 0.6);
    const boundary = Math.max(
      remaining.lastIndexOf(" ", maxLength),
      remaining.lastIndexOf(",", maxLength),
      remaining.lastIndexOf("}", maxLength),
      remaining.lastIndexOf("]", maxLength)
    );
    const splitAt = boundary >= preferredWindowStart ? boundary + 1 : maxLength;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function kindFromName(name: string): PdpGeoRagChunk["kind"] {
  if (/orchestrat|rag-map|manifest|analysis-prompt/i.test(name)) {
    return "orchestration";
  }
  if (/schema/i.test(name)) {
    return "schema";
  }
  if (/eeat|e-e-a-t/i.test(name)) {
    return "eeat";
  }
  if (/cep/i.test(name)) {
    return "cep";
  }
  if (/best/i.test(name)) {
    return "best-practice";
  }
  if (/geo-research|geo-paper|generative/i.test(name)) {
    return "geo-research";
  }
  if (/official|openai|google|gemini|perplexity|platform|docs|search-api|embedding|file-search|vector-store/i.test(name)) {
    return "official-docs";
  }
  if (/terminology/i.test(name)) {
    return "terminology";
  }
  if (/locale/i.test(name)) {
    return "locale";
  }
  return "custom";
}

function inferRagChunkRouting(
  kind: PdpGeoRagChunk["kind"],
  source: string,
  title: string | undefined,
  text: string
): { intents: PdpGeoRagIntent[]; fieldTargets: PdpGeoRagFieldTarget[] } {
  const haystack = `${source} ${title ?? ""} ${text}`.toLowerCase();
  const explicitRouting = explicitUrlRouting(kind, source, title);
  if (explicitRouting) {
    return explicitRouting;
  }

  const intents = new Set<PdpGeoRagIntent>();
  const fieldTargets = new Set<PdpGeoRagFieldTarget>();

  if (kind === "terminology" || kind === "locale" || /\blocale\b|terminology|market wording|locali[sz]e|금칙|표현|wording/.test(haystack)) {
    intents.add("locale");
    fieldTargets.add("PDP.content");
  }
  if (kind === "orchestration" || /orchestration|routing|rag index|rag-index|overlap|conflict|missing|coverage|content unit|문서 단위|내용 단위|누락|충돌|중복/.test(haystack)) {
    intents.add("retrieval");
    intents.add("general");
    fieldTargets.add("retrieval");
    fieldTargets.add("diagnostics");
  }
  if (kind === "official-docs" || /retrieval|embedding|vector|search api|grounding|provider|openai|gemini|perplexity/.test(haystack)) {
    intents.add("retrieval");
    fieldTargets.add("retrieval");
    fieldTargets.add("diagnostics");
  }
  if (/faq|question|answer|mainentity|customer question|q&a/.test(haystack)) {
    intents.add("faq");
    fieldTargets.add("FAQPage.mainEntity");
  }
  if (/howto|how to use|stepwise|\bstep\b|usage|routine|direction|apply|application|사용법|사용\s*순서/.test(haystack)) {
    intents.add("howTo");
    fieldTargets.add("HowTo.step");
  }
  if (/claim|evidence|source-supported|reported result|clinical|metric|award|certification|trust|trustworthiness|expertise|authoritativeness|positive notes|positiveNotes|additionalproperty|propertyvalue|효능|효과|근거/.test(haystack)) {
    intents.add("claims");
    intents.add("evidence");
    fieldTargets.add("Product.description");
    fieldTargets.add("Product.additionalProperty");
    fieldTargets.add("Product.positiveNotes");
  }
  if (/customer|target customer|audience|entry point|cep|concern|skin type|use occasion|routine timing|buying|discovery|review-backed preference/.test(haystack)) {
    intents.add("customer");
    fieldTargets.add("WebPage.description");
    fieldTargets.add("Product.description");
  }
  if (/review|rating|experience|texture|absorption|comfort|satisfaction|customer language|사용감|흡수감|리뷰/.test(haystack)) {
    intents.add("review");
    fieldTargets.add("FAQPage.mainEntity");
    fieldTargets.add("Product.description");
    fieldTargets.add("Product.positiveNotes");
  }
  if (/schema|json-ld|webpage|product\.description|webpage\.description|product entity|breadcrumb|offer|brand|manufacturer|graph|structured data/.test(haystack)) {
    intents.add("schema");
    fieldTargets.add("Product.description");
    fieldTargets.add("WebPage.description");
  }
  if (/breadcrumb/.test(haystack)) {
    fieldTargets.add("BreadcrumbList");
  }
  if (/ocr|sentence diagnostics|classified sentence|diagnostic/.test(haystack)) {
    intents.add("evidence");
    fieldTargets.add("diagnostics");
  }

  if (kind === "geo-research" && intents.size === 0) {
    intents.add("general");
    fieldTargets.add("PDP.content");
  }
  if (kind === "eeat" && intents.size === 0) {
    intents.add("evidence");
    intents.add("claims");
  }
  if (kind === "cep" && intents.size === 0) {
    intents.add("customer");
  }
  if (intents.size === 0) {
    intents.add("general");
  }
  if (fieldTargets.size === 0) {
    fieldTargets.add("PDP.content");
  }

  return {
    intents: Array.from(intents),
    fieldTargets: Array.from(fieldTargets)
  };
}

function explicitUrlRouting(
  kind: PdpGeoRagChunk["kind"],
  source: string,
  title: string | undefined
): { intents: PdpGeoRagIntent[]; fieldTargets: PdpGeoRagFieldTarget[] } | undefined {
  const sourceKey = source.toLowerCase();
  const titleKey = (title ?? "").toLowerCase();

  if (/schema\.org\/faqpage/.test(sourceKey) || /^faqpage\b/.test(titleKey)) {
    return {
      intents: ["schema", "faq"],
      fieldTargets: ["FAQPage.mainEntity"]
    };
  }
  if (/schema\.org\/howto/.test(sourceKey) || /^howto\b/.test(titleKey)) {
    return {
      intents: ["schema", "howTo"],
      fieldTargets: ["HowTo.step"]
    };
  }
  if (/schema\.org\/product/.test(sourceKey) || /^product\b/.test(titleKey)) {
    return {
      intents: ["schema", "claims", "customer"],
      fieldTargets: ["Product.description", "Product.additionalProperty", "Product.positiveNotes"]
    };
  }
  if (/schema\.org\/webpage/.test(sourceKey) || /^webpage\b/.test(titleKey)) {
    return {
      intents: ["schema", "customer"],
      fieldTargets: ["WebPage.description"]
    };
  }
  if (/schema\.org\/breadcrumblist/.test(sourceKey) || /^breadcrumblist\b/.test(titleKey)) {
    return {
      intents: ["schema"],
      fieldTargets: ["BreadcrumbList"]
    };
  }
  if (/schema\.org\//.test(sourceKey)) {
    return {
      intents: ["schema"],
      fieldTargets: ["PDP.content"]
    };
  }
  if (kind === "official-docs" || /developers\.openai\.com|platform\.openai\.com|developers\.google\.com|ai\.google\.dev|docs\.perplexity\.ai/.test(sourceKey)) {
    if (/structured-data|product/.test(sourceKey) || /structured data|product/.test(titleKey)) {
      return {
        intents: ["retrieval", "schema", "claims"],
        fieldTargets: ["retrieval", "diagnostics", "Product.description", "Product.additionalProperty"]
      };
    }
    if (/grounding|search/.test(sourceKey) || /grounding|search/.test(titleKey)) {
      return {
        intents: ["retrieval", "evidence"],
        fieldTargets: ["retrieval", "diagnostics"]
      };
    }
    return {
      intents: ["retrieval"],
      fieldTargets: ["retrieval", "diagnostics"]
    };
  }

  return undefined;
}

function retrievalBoost(chunk: PdpGeoRagChunk, locale: PdpGeoLocale, market?: string): number {
  const text = `${chunk.source} ${chunk.title ?? ""} ${chunk.text}`;
  const indexedDocument = findPdpGeoRagIndexEntry(chunk.source);
  const indexedSection = findPdpGeoRagSectionEntry(chunk.source, chunk.title);
  let boost = 0;

  boost += (indexedSection?.priority ?? indexedDocument?.priority ?? 0) * 0.08;
  if (chunk.kind === "schema") {
    boost += 0.05;
  }
  if (chunk.kind === "orchestration") {
    boost += 0.07;
  }
  if (chunk.kind === "terminology" || chunk.kind === "locale") {
    boost += 0.07;
  }
  if (chunk.kind === "official-docs") {
    boost += 0.06;
  }
  if (chunk.kind === "best-practice" || chunk.kind === "geo-research") {
    boost += 0.08;
  }
  if (chunk.kind === "eeat" || chunk.kind === "cep") {
    boost += 0.04;
  }
  if (/ocr|sentence diagnostics|sentence intent|classified sentence|citation|cite|quotable|answer-ready|faqpage|mainentity|review|customer|webpage\.description|product\.description|claim support|evidence hierarchy|public wording/i.test(text)) {
    boost += 0.04;
  }
  if (text.includes(locale)) {
    boost += 0.05;
  }
  if (market && text.includes(market)) {
    boost += 0.03;
  }

  return boost;
}

function createContextualRetrievalText(chunk: PdpGeoRagChunk): string {
  return [
    `Document: ${chunk.source}`,
    chunk.title ? `Section: ${chunk.title}` : undefined,
    chunk.metadata.headingPath ? `Heading path: ${chunk.metadata.headingPath}` : undefined,
    `RAG kind: ${chunk.kind}`,
    chunk.metadata.sourceRole ? `Source role: ${chunk.metadata.sourceRole}` : undefined,
    chunk.metadata.checkedAt ? `Checked at: ${chunk.metadata.checkedAt}` : undefined,
    chunk.intents && chunk.intents.length > 0 ? `Generation intents: ${chunk.intents.join(", ")}` : undefined,
    chunk.fieldTargets && chunk.fieldTargets.length > 0 ? `Schema and content fields: ${chunk.fieldTargets.join(", ")}` : undefined,
    chunk.text
  ].filter(Boolean).join("\n");
}

function rerankLocalChunks(chunks: PdpGeoRetrievedChunk[], request: PdpGeoRetrieverRequest): PdpGeoRetrievedChunk[] {
  return chunks
    .map((chunk) => {
      const rerankBoost = lightweightRerankBoost(chunk, request);
      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          baseScore: roundScore(chunk.score),
          rerankBoost: roundScore(rerankBoost),
          reranker: "local-contextual-hybrid"
        },
        score: clamp(chunk.score + rerankBoost, 0, 1)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function lightweightRerankBoost(chunk: PdpGeoRagChunk, request: PdpGeoRetrieverRequest): number {
  const query = request.query.toLowerCase();
  const contextualText = createContextualRetrievalText(chunk).toLowerCase();
  let boost = 0;

  if (chunk.fieldTargets?.some((fieldTarget) => query.includes(fieldTarget.toLowerCase()))) {
    boost += 0.05;
  }
  if (chunk.intents?.some((intent) => query.includes(intent.toLowerCase()))) {
    boost += 0.03;
  }
  if (chunk.kind === "geo-research" && /geo|generative|answer-ready|retrieval|query planning/i.test(query)) {
    boost += 0.04;
  }
  if (chunk.kind === "cep" && /cep|customer|entry point|routine|review|faq/i.test(query)) {
    boost += 0.04;
  }
  if (chunk.kind === "eeat" && /e-e-a-t|eeat|trust|evidence|claim|safety/i.test(query)) {
    boost += 0.04;
  }

  const productEvidenceTerms = tokenize([
    request.product.name,
    request.product.brand,
    request.product.category,
    ...request.product.benefits,
    ...request.product.ingredients,
    ...request.product.usage,
    ...request.product.reviews.keywords
  ].filter(Boolean).join(" "));
  const productOverlap = lexicalSimilarity(productEvidenceTerms, tokenize(contextualText));
  boost += Math.min(0.05, productOverlap * 0.12);

  return boost;
}

function embedText(text: string): number[] {
  const vector = Array.from({ length: 384 }, () => 0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const index = stableHash(token) % vector.length;
    vector[index] = (vector[index] ?? 0) + (1 / Math.sqrt(Math.max(token.length, 1)));
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function lexicalSimilarity(queryTerms: string[], candidateTerms: string[]): number {
  if (queryTerms.length === 0 || candidateTerms.length === 0) {
    return 0;
  }
  const candidate = new Set(candidateTerms);
  const overlap = new Set(queryTerms.filter((term) => candidate.has(term)));
  return overlap.size / Math.sqrt(queryTerms.length * candidate.size);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, index) => sum + (value * (b[index] ?? 0)), 0);
  return clamp((dot + 1) / 2, 0, 1);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}
