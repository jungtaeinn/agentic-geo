import type { EmbeddingRuntimeConfig, RerankerRuntimeConfig } from "../llm/types";
import type { AiTokenUsage, RuntimePipelineStep } from "../types";
import {
  findProductExtractorRagIndexEntry,
  findProductExtractorRagSectionEntry
} from "./rag-index";

export interface ProductExtractorRagDocumentInput {
  name: string;
  content: string;
  version?: string;
}

export interface ProductExtractorRagSettings {
  maxChunks?: number;
  scoreThreshold?: number;
}

export interface ProductExtractorRagEvidenceInput {
  source: string;
  productName?: string;
  imageTexts: Array<{
    imageUrl: string;
    text: string;
  }>;
}

export interface ProductExtractorRagRetrievedDocument {
  name: string;
  content: string;
  version?: string;
  score: number;
  sourceDocument: string;
  chunkId: string;
  kind: ProductExtractorRagKind;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
}

export type ProductExtractorRagKind =
  | "orchestration"
  | "analysis-prompt"
  | "product-normalization"
  | "ocr-classification"
  | "review-extraction"
  | "faq-extraction"
  | "custom";

export type ProductExtractorRagIntent =
  | "orchestration"
  | "normalization"
  | "classification"
  | "exclusion"
  | "evidence"
  | "review"
  | "faq"
  | "schema-ready"
  | "diagnostics"
  | "general";

export type ProductExtractorRagFieldTarget =
  | "geoProduct"
  | "benefits"
  | "effects"
  | "ingredients"
  | "usage"
  | "faq"
  | "reviews"
  | "metrics"
  | "ocr.sentenceInsights"
  | "contentAnalysis.sections"
  | "rag.chunks"
  | "diagnostics";

/** Builds an extraction-policy query from product evidence before OCR classification. */
export function createProductExtractorRagQuery(input: ProductExtractorRagEvidenceInput): string {
  const evidenceText = input.imageTexts
    .slice(0, 12)
    .map((item) => item.text)
    .join("\n");

  return [
    "Classify PDP OCR and long-scroll evidence into product, benefit, effect, ingredient, usage, FAQ, review, price, and metric fields.",
    `Source: ${input.source}.`,
    input.productName ? `Product name: ${input.productName}.` : undefined,
    evidenceText,
    "Need policy for excluding cart, coupon, delivery, exchange, refund, legal, and page chrome text.",
    "Need sentence-level OCR reconstruction, source-backed claims, complete product evidence, review signals, FAQ evidence, and schema-ready RAG chunks."
  ].filter(Boolean).join("\n");
}

/** Retrieves the most relevant RAG policy chunks for the current product evidence. */
export async function retrieveProductExtractorRagDocuments(input: {
  query: string;
  documents: ProductExtractorRagDocumentInput[];
  settings?: ProductExtractorRagSettings;
  embedding?: EmbeddingRuntimeConfig;
  reranker?: RerankerRuntimeConfig;
  onRuntimeStep?: (step: RuntimePipelineStep) => void;
}): Promise<ProductExtractorRagRetrievedDocument[]> {
  const maxChunks = input.settings?.maxChunks ?? 6;
  const scoreThreshold = input.settings?.scoreThreshold ?? 0.06;
  const chunks = input.documents.flatMap((document) => chunkDocument(document));

  if (chunks.length === 0) {
    return [];
  }

  const retrieved = (await scoreRetrievedChunks(input.query, chunks, input.embedding, input.onRuntimeStep))
    .map((chunk) => {
      return {
        name: `${chunk.sourceDocument}#${chunk.chunkIndex + 1}`,
        content: [
          `Retrieved RAG policy chunk from ${chunk.sourceDocument}.`,
          chunk.title ? `Section: ${chunk.title}` : undefined,
          `Kind: ${chunk.kind}.`,
          `Intents: ${chunk.intents.join(", ")}.`,
          `Field targets: ${chunk.fieldTargets.join(", ")}.`,
          chunk.content
        ].filter(Boolean).join("\n"),
        version: chunk.version,
        score: chunk.score,
        sourceDocument: chunk.sourceDocument,
        chunkId: chunk.id,
        kind: chunk.kind,
        intents: chunk.intents,
        fieldTargets: chunk.fieldTargets
      };
    })
    .filter((chunk) => chunk.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(maxChunks * 3, maxChunks));

  return rerankRetrievedChunks(input.query, retrieved, input.reranker, maxChunks, input.onRuntimeStep);
}

async function scoreRetrievedChunks(
  query: string,
  chunks: Array<{
    id: string;
    sourceDocument: string;
    title?: string;
    content: string;
    version?: string;
    chunkIndex: number;
    kind: ProductExtractorRagKind;
    intents: ProductExtractorRagIntent[];
    fieldTargets: ProductExtractorRagFieldTarget[];
  }>,
  embedding?: EmbeddingRuntimeConfig,
  onRuntimeStep?: (step: RuntimePipelineStep) => void
): Promise<Array<{
  id: string;
  sourceDocument: string;
  title?: string;
  content: string;
  version?: string;
  chunkIndex: number;
  kind: ProductExtractorRagKind;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
  score: number;
}>> {
  const queryTerms = tokenize(query);
  const remoteEmbeddingResult = await createAzureEmbeddings(
    [query, ...chunks.map((chunk) => chunk.content)],
    embedding
  ).catch(() => undefined);
  const remoteEmbeddings = remoteEmbeddingResult?.embeddings;
  if (remoteEmbeddingResult) {
    const aistudioEmbedding = embedding?.provider === "aistudio";
    onRuntimeStep?.({
      stage: "embedding",
      label: "Embedding",
      provider: aistudioEmbedding ? "aistudio" : "azure-api",
      service: aistudioEmbedding ? "AI Studio model deployment" : "Azure model deployment",
      deployment: embedding?.deployment,
      model: embedding?.model,
      called: true,
      tokenUsage: remoteEmbeddingResult.usage,
      details: `${chunks.length + 1} texts embedded for extractor RAG retrieval.`
    });
  }
  const queryEmbedding = remoteEmbeddings?.[0] ?? embedText(query);

  return chunks.map((chunk, index) => {
    const lexicalScore = lexicalSimilarity(queryTerms, tokenize(`${chunk.sourceDocument} ${chunk.title ?? ""} ${chunk.content}`));
    const semanticEmbedding = remoteEmbeddings?.[index + 1] ?? embedText(chunk.content);
    const semanticScore = cosineSimilarity(queryEmbedding, semanticEmbedding);
    const score = clamp((lexicalScore * 0.5) + (semanticScore * 0.42) + retrievalBoost(chunk), 0, 1);

    return {
      ...chunk,
      score
    };
  });
}

async function rerankRetrievedChunks(
  query: string,
  retrieved: ProductExtractorRagRetrievedDocument[],
  reranker: RerankerRuntimeConfig | undefined,
  maxChunks: number,
  onRuntimeStep?: (step: RuntimePipelineStep) => void
): Promise<ProductExtractorRagRetrievedDocument[]> {
  if (!reranker || reranker.provider === "local-hybrid") {
    return retrieved.slice(0, maxChunks);
  }

  if ((reranker.provider === "cohere" || reranker.provider === "aistudio-bedrock-cohere") && (!reranker.endpoint || !reranker.apiKey || retrieved.length <= 1)) {
    return retrieved.slice(0, maxChunks);
  }

  if (reranker.provider === "azure-ai-search-semantic" && (!reranker.endpoint || !reranker.apiKey || !reranker.indexName)) {
    return retrieved.slice(0, maxChunks);
  }

  const reranked = reranker.provider === "azure-ai-search-semantic"
    ? await retrieveWithAzureAiSearchSemantic(query, reranker, maxChunks).catch(() => undefined)
    : reranker.provider === "aistudio-bedrock-cohere"
      ? await rerankWithAistudioBedrock(query, retrieved, reranker, maxChunks).catch(() => undefined)
      : await rerankWithCohere(query, retrieved, reranker, maxChunks).catch(() => undefined);
  if (reranked?.length) {
    onRuntimeStep?.({
      stage: "reranking",
      label: "Reranking",
      provider: reranker.provider,
      service: reranker.provider === "azure-ai-search-semantic"
        ? "Azure AI Search semantic ranker"
        : reranker.provider === "aistudio-bedrock-cohere"
          ? "AI Studio Bedrock Cohere Rerank"
          : "Cohere Rerank",
      model: reranker.provider === "cohere" || reranker.provider === "aistudio-bedrock-cohere" ? reranker.model : undefined,
      called: true,
      details: `${retrieved.length} candidates reranked to ${Math.min(maxChunks, reranked.length)} results.`
    });
  }
  return reranked?.length ? reranked : retrieved.slice(0, maxChunks);
}

async function createAzureEmbeddings(texts: string[], embedding?: EmbeddingRuntimeConfig): Promise<{ embeddings: number[][]; usage?: AiTokenUsage } | undefined> {
  const isAistudio = embedding?.provider === "aistudio";
  if (
    (embedding?.provider !== "azure-openai" && !isAistudio)
    || !embedding.apiKey
    || !embedding.endpoint
    || !embedding.deployment
    || texts.length === 0
  ) {
    return undefined;
  }

  const endpoint = embedding.endpoint.replace(/\/$/, "");
  // AI Studio proxies Azure OpenAI embeddings: same path, Bearer auth, optional api-version.
  const trimmedApiVersion = embedding.apiVersion?.trim();
  const apiVersionQuery = isAistudio
    ? (trimmedApiVersion ? `?api-version=${encodeURIComponent(trimmedApiVersion)}` : "")
    : `?api-version=${encodeURIComponent(trimmedApiVersion || "2025-04-01-preview")}`;
  const authHeader: Record<string, string> = isAistudio
    ? { Authorization: `Bearer ${embedding.apiKey}` }
    : { "api-key": embedding.apiKey };
  const response = await fetch(`${endpoint}/openai/deployments/${encodeURIComponent(embedding.deployment)}/embeddings${apiVersionQuery}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader
    },
    body: JSON.stringify({
      input: texts
    })
  });

  if (!response.ok) {
    throw new Error(`Azure embedding failed: ${response.status}`);
  }

  const payload = await response.json() as {
    data?: Array<{
      index?: number;
      embedding?: number[];
    }>;
    usage?: unknown;
  };

  const ordered = (payload.data ?? [])
    .filter((item): item is { index: number; embedding: number[] } => typeof item.index === "number" && Array.isArray(item.embedding))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  return ordered.length === texts.length
    ? {
      embeddings: ordered,
      usage: tokenUsageFromAzureEmbedding(payload.usage)
    }
    : undefined;
}

function tokenUsageFromAzureEmbedding(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const result: AiTokenUsage = {
    inputTokens: scalarNumberField(usage.prompt_tokens),
    totalTokens: scalarNumberField(usage.total_tokens)
  };
  return result.inputTokens !== undefined || result.totalTokens !== undefined ? result : undefined;
}

function scalarNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function rerankWithCohere(
  query: string,
  retrieved: ProductExtractorRagRetrievedDocument[],
  reranker: RerankerRuntimeConfig,
  maxChunks: number
): Promise<ProductExtractorRagRetrievedDocument[]> {
  const endpoint = normalizeCohereRerankEndpoint(reranker.endpoint ?? "");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${reranker.apiKey}`,
      "Content-Type": "application/json",
      "api-key": reranker.apiKey ?? ""
    },
    body: JSON.stringify({
      model: reranker.model || undefined,
      query,
      documents: retrieved.map((document) => document.content),
      top_n: maxChunks
    })
  });

  if (!response.ok) {
    throw new Error(`Cohere rerank failed: ${response.status}`);
  }

  const payload = await response.json() as {
    results?: Array<{
      index?: number;
      relevance_score?: number;
    }>;
  };

  return (payload.results ?? [])
    .flatMap((result) => {
      const index = typeof result.index === "number" ? result.index : -1;
      const document = retrieved[index];
      if (!document) {
        return [];
      }
      return [{
        ...document,
        score: typeof result.relevance_score === "number" ? result.relevance_score : document.score
      }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);
}

function normalizeCohereRerankEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/$/, "");
  if (/\/rerank(?:\?|$)/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v2/rerank`;
}

/**
 * Reranks candidates through the AI Studio gateway, which fronts Cohere Rerank on
 * AWS Bedrock. Uses the Bedrock `/model/{model}/invoke` contract with Bearer auth;
 * the response mirrors Cohere's `results: [{ index, relevance_score }]` shape.
 */
async function rerankWithAistudioBedrock(
  query: string,
  retrieved: ProductExtractorRagRetrievedDocument[],
  reranker: RerankerRuntimeConfig,
  maxChunks: number
): Promise<ProductExtractorRagRetrievedDocument[]> {
  const endpoint = (reranker.endpoint ?? "").trim().replace(/\/$/, "");
  const model = reranker.model?.trim() || "cohere.rerank-v3-5:0";
  const response = await fetch(`${endpoint}/model/${encodeURIComponent(model)}/invoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${reranker.apiKey ?? ""}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      documents: retrieved.map((document) => document.content),
      top_n: maxChunks,
      api_version: 2
    })
  });

  if (!response.ok) {
    throw new Error(`AI Studio Bedrock rerank failed: ${response.status}`);
  }

  const payload = await response.json() as {
    results?: Array<{
      index?: number;
      relevance_score?: number;
    }>;
  };

  return (payload.results ?? [])
    .flatMap((result) => {
      const index = typeof result.index === "number" ? result.index : -1;
      const document = retrieved[index];
      if (!document) {
        return [];
      }
      return [{
        ...document,
        score: typeof result.relevance_score === "number" ? result.relevance_score : document.score
      }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);
}

async function retrieveWithAzureAiSearchSemantic(
  query: string,
  reranker: RerankerRuntimeConfig,
  maxChunks: number
): Promise<ProductExtractorRagRetrievedDocument[]> {
  const endpoint = reranker.endpoint?.replace(/\/$/, "");
  const indexName = reranker.indexName ?? "";
  const semanticConfiguration = reranker.semanticConfiguration || "default";
  const apiVersion = "2024-07-01";
  const response = await fetch(`${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${apiVersion}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": reranker.apiKey ?? ""
    },
    body: JSON.stringify({
      search: query,
      queryType: "semantic",
      semanticConfiguration,
      queryLanguage: reranker.queryLanguage || "ko-kr",
      top: maxChunks
    })
  });

  if (!response.ok) {
    throw new Error(`Azure AI Search semantic ranker failed: ${response.status}`);
  }

  const payload = await response.json() as {
    value?: Array<Record<string, unknown>>;
  };

  return (payload.value ?? [])
    .flatMap((item, index): ProductExtractorRagRetrievedDocument[] => {
      const content = stringField(item, ["content", "text", "chunk", "chunkText", "body", "description"]) ?? longestStringField(item);
      if (!content) {
        return [];
      }

      const sourceDocument = stringField(item, ["sourceDocument", "source", "filename", "title", "id"]) ?? "azure-ai-search";
      const score = numberField(item, ["@search.rerankerScore", "@search.score"]) ?? 0;
      const kind = kindFromName(sourceDocument);
      return [{
        name: `${sourceDocument}#${index + 1}`,
        content,
        score,
        sourceDocument,
        chunkId: stringField(item, ["chunkId", "id", "key"]) ?? `azure-ai-search-${index + 1}`,
        kind,
        ...inferChunkRouting(kind, sourceDocument, undefined, content)
      }];
    })
    .slice(0, maxChunks);
}

function stringField(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberField(item: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function longestStringField(item: Record<string, unknown>): string | undefined {
  return Object.entries(item)
    .filter(([key, value]) => !key.startsWith("@search.") && typeof value === "string" && value.trim().length > 0)
    .map(([, value]) => String(value).trim())
    .sort((a, b) => b.length - a.length)[0];
}

function chunkDocument(document: ProductExtractorRagDocumentInput): Array<{
  id: string;
  sourceDocument: string;
  title?: string;
  content: string;
  version?: string;
  chunkIndex: number;
  kind: ProductExtractorRagKind;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
}> {
  return splitMarkdownSections(document.content).map((section, index) => {
    const indexedDocument = findProductExtractorRagIndexEntry(document.name);
    const indexedSection = findProductExtractorRagSectionEntry(document.name, section.title);
    const kind = indexedDocument?.kind ?? kindFromName(document.name);
    const inferredRouting = inferChunkRouting(kind, document.name, section.title, section.text);
    const routing = {
      intents: indexedSection?.intents ?? indexedDocument?.intents ?? inferredRouting.intents,
      fieldTargets: indexedSection?.fieldTargets ?? indexedDocument?.fieldTargets ?? inferredRouting.fieldTargets
    };

    return {
      id: `${slug(document.name)}-${index + 1}`,
      sourceDocument: document.name,
      title: section.title,
      content: section.text,
      version: document.version,
      chunkIndex: index,
      kind,
      intents: routing.intents,
      fieldTargets: routing.fieldTargets
    };
  });
}

function splitMarkdownSections(content: string): Array<{ title?: string; text: string }> {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const sections: Array<{ title?: string; text: string }> = [];
  const lines = normalized.split("\n");
  let title: string | undefined;
  let buffer: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      if (buffer.join("\n").trim()) {
        sections.push({ title, text: buffer.join("\n").trim() });
      }
      title = heading[1]?.trim();
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }

  if (buffer.join("\n").trim()) {
    sections.push({ title, text: buffer.join("\n").trim() });
  }

  return sections.flatMap((section) => splitLongSection(section));
}

function splitLongSection(section: { title?: string; text: string }): Array<{ title?: string; text: string }> {
  const maxLength = 1100;
  if (section.text.length <= maxLength) {
    return [section];
  }
  const paragraphs = section.text.split(/\n{2,}/);
  const chunks: Array<{ title?: string; text: string }> = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > maxLength && current.trim()) {
      chunks.push({ title: section.title, text: current.trim() });
      current = paragraph;
    } else {
      current = [current, paragraph].filter(Boolean).join("\n\n");
    }
  }
  if (current.trim()) {
    chunks.push({ title: section.title, text: current.trim() });
  }
  return chunks;
}

function kindFromName(name: string): ProductExtractorRagKind {
  if (/orchestrat|manifest|rag-index|rag-map/i.test(name)) {
    return "orchestration";
  }
  if (/analysis-prompt/i.test(name)) {
    return "analysis-prompt";
  }
  if (/product-normalization|normalization/i.test(name)) {
    return "product-normalization";
  }
  if (/ocr|classification|keyword/i.test(name)) {
    return "ocr-classification";
  }
  if (/review/i.test(name)) {
    return "review-extraction";
  }
  if (/faq/i.test(name)) {
    return "faq-extraction";
  }
  return "custom";
}

function inferChunkRouting(
  kind: ProductExtractorRagKind,
  sourceDocument: string,
  title: string | undefined,
  content: string
): { intents: ProductExtractorRagIntent[]; fieldTargets: ProductExtractorRagFieldTarget[] } {
  const haystack = `${sourceDocument} ${title ?? ""} ${content}`.toLowerCase();
  const intents = new Set<ProductExtractorRagIntent>();
  const fieldTargets = new Set<ProductExtractorRagFieldTarget>();

  if (kind === "orchestration" || /orchestration|routing|rag index|rag-index|coverage|conflict|overlap|missing|누락|충돌|중복/.test(haystack)) {
    intents.add("orchestration");
    intents.add("diagnostics");
    fieldTargets.add("diagnostics");
    fieldTargets.add("rag.chunks");
  }
  if (kind === "analysis-prompt" || /analysis prompt|base instruction|evidence-only|근거|정책/.test(haystack)) {
    intents.add("evidence");
    intents.add("diagnostics");
    fieldTargets.add("geoProduct");
    fieldTargets.add("diagnostics");
  }
  if (kind === "product-normalization" || /normalize|normalization|geoProduct|contentAnalysis|section|field|schema-ready|정규화|분류/.test(haystack)) {
    intents.add("normalization");
    intents.add("schema-ready");
    fieldTargets.add("geoProduct");
    fieldTargets.add("contentAnalysis.sections");
    fieldTargets.add("rag.chunks");
  }
  if (kind === "ocr-classification" || /ocr|sentence|keyword|classification|benefit|effect|ingredient|usage|효능|효과|성분|사용법/.test(haystack)) {
    intents.add("classification");
    intents.add("evidence");
    fieldTargets.add("ocr.sentenceInsights");
    fieldTargets.add("benefits");
    fieldTargets.add("effects");
    fieldTargets.add("ingredients");
    fieldTargets.add("usage");
  }
  if (/exclude|cart|coupon|delivery|refund|legal|chrome|purchase|혜택|배송|교환|반품|환불|법적|장바구니/.test(haystack)) {
    intents.add("exclusion");
    fieldTargets.add("diagnostics");
  }
  if (kind === "review-extraction" || /review|rating|customer|texture|absorption|satisfaction|리뷰|평점|사용감|흡수감/.test(haystack)) {
    intents.add("review");
    intents.add("evidence");
    fieldTargets.add("reviews");
  }
  if (kind === "faq-extraction" || /faq|question|answer|mainentity|q&a|질문|답변/.test(haystack)) {
    intents.add("faq");
    intents.add("evidence");
    fieldTargets.add("faq");
  }
  if (/metric|clinical|survey|rating|count|\b\d+(?:\.\d+)?\s?%|임상|수치|만족도/.test(haystack)) {
    intents.add("evidence");
    fieldTargets.add("metrics");
  }
  if (intents.size === 0) {
    intents.add("general");
  }
  if (fieldTargets.size === 0) {
    fieldTargets.add("geoProduct");
  }

  return {
    intents: Array.from(intents),
    fieldTargets: Array.from(fieldTargets)
  };
}

function retrievalBoost(chunk: {
  sourceDocument: string;
  title?: string;
  content: string;
  kind: ProductExtractorRagKind;
  intents: ProductExtractorRagIntent[];
  fieldTargets: ProductExtractorRagFieldTarget[];
}): number {
  const text = `${chunk.sourceDocument} ${chunk.title ?? ""} ${chunk.content}`;
  const indexedDocument = findProductExtractorRagIndexEntry(chunk.sourceDocument);
  const indexedSection = findProductExtractorRagSectionEntry(chunk.sourceDocument, chunk.title);
  let boost = 0;
  boost += (indexedSection?.priority ?? indexedDocument?.priority ?? 0) * 0.08;
  if (chunk.kind === "orchestration" || chunk.intents.includes("orchestration")) {
    boost += 0.07;
  }
  if (chunk.intents.includes("classification") || chunk.fieldTargets.includes("ocr.sentenceInsights")) {
    boost += 0.06;
  }
  if (chunk.intents.includes("normalization") || chunk.fieldTargets.includes("geoProduct")) {
    boost += 0.04;
  }
  if (chunk.intents.includes("exclusion")) {
    boost += 0.06;
  }
  if (/ocr|sentence|classification|keyword/i.test(text)) {
    boost += 0.08;
  }
  if (/product|normalization|field|schema/i.test(text)) {
    boost += 0.05;
  }
  if (/review|faq|question|answer/i.test(text)) {
    boost += 0.04;
  }
  if (/exclude|cart|coupon|delivery|refund|legal|chrome|혜택|배송|반품/i.test(text)) {
    boost += 0.06;
  }
  return boost;
}

function embedText(text: string): number[] {
  const vector = Array.from({ length: 96 }, () => 0);
  for (const token of tokenize(text)) {
    const index = stableHash(token) % vector.length;
    vector[index] = (vector[index] ?? 0) + (1 / Math.sqrt(Math.max(token.length, 1)));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
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
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "rag";
}
