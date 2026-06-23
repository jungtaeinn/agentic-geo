import type { EmbeddingRuntimeConfig, RerankerRuntimeConfig } from "../llm/types";
import type { AiTokenUsage, RuntimePipelineStep } from "../types";

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
}

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
          chunk.content
        ].filter(Boolean).join("\n"),
        version: chunk.version,
        score: chunk.score,
        sourceDocument: chunk.sourceDocument,
        chunkId: chunk.id
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
  score: number;
}>> {
  const queryTerms = tokenize(query);
  const remoteEmbeddingResult = await createAzureEmbeddings(
    [query, ...chunks.map((chunk) => chunk.content)],
    embedding
  ).catch(() => undefined);
  const remoteEmbeddings = remoteEmbeddingResult?.embeddings;
  if (remoteEmbeddingResult) {
    onRuntimeStep?.({
      stage: "embedding",
      label: "Embedding",
      provider: "azure-api",
      service: "Azure model deployment",
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

  if (reranker.provider === "cohere" && (!reranker.endpoint || !reranker.apiKey || retrieved.length <= 1)) {
    return retrieved.slice(0, maxChunks);
  }

  if (reranker.provider === "azure-ai-search-semantic" && (!reranker.endpoint || !reranker.apiKey || !reranker.indexName)) {
    return retrieved.slice(0, maxChunks);
  }

  const reranked = reranker.provider === "azure-ai-search-semantic"
    ? await retrieveWithAzureAiSearchSemantic(query, reranker, maxChunks).catch(() => undefined)
    : await rerankWithCohere(query, retrieved, reranker, maxChunks).catch(() => undefined);
  if (reranked?.length) {
    onRuntimeStep?.({
      stage: "reranking",
      label: "Reranking",
      provider: reranker.provider,
      service: reranker.provider === "azure-ai-search-semantic" ? "Azure AI Search semantic ranker" : "Cohere Rerank",
      model: reranker.provider === "cohere" ? reranker.model : undefined,
      called: true,
      details: `${retrieved.length} candidates reranked to ${Math.min(maxChunks, reranked.length)} results.`
    });
  }
  return reranked?.length ? reranked : retrieved.slice(0, maxChunks);
}

async function createAzureEmbeddings(texts: string[], embedding?: EmbeddingRuntimeConfig): Promise<{ embeddings: number[][]; usage?: AiTokenUsage } | undefined> {
  if (
    embedding?.provider !== "azure-openai"
    || !embedding.apiKey
    || !embedding.endpoint
    || !embedding.deployment
    || texts.length === 0
  ) {
    return undefined;
  }

  const endpoint = embedding.endpoint.replace(/\/$/, "");
  const apiVersion = embedding.apiVersion ?? "2025-04-01-preview";
  const response = await fetch(`${endpoint}/openai/deployments/${encodeURIComponent(embedding.deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": embedding.apiKey
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
      return [{
        name: `${sourceDocument}#${index + 1}`,
        content,
        score,
        sourceDocument,
        chunkId: stringField(item, ["chunkId", "id", "key"]) ?? `azure-ai-search-${index + 1}`
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
}> {
  return splitMarkdownSections(document.content).map((section, index) => ({
    id: `${slug(document.name)}-${index + 1}`,
    sourceDocument: document.name,
    title: section.title,
    content: section.text,
    version: document.version,
    chunkIndex: index
  }));
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

function retrievalBoost(chunk: { sourceDocument: string; title?: string; content: string }): number {
  const text = `${chunk.sourceDocument} ${chunk.title ?? ""} ${chunk.content}`;
  let boost = 0;
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
