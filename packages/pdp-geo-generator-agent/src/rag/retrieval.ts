import type {
  PdpGeoLocale,
  PdpGeoRagChunk,
  PdpGeoRagSettings,
  PdpGeoRetrievedChunk,
  PdpGeoRetriever,
  PdpGeoRetrieverRequest,
  PdpProductSignal
} from "../types";

export interface RetrievePdpGeoRagChunksOptions {
  apiKey?: string;
  customRetriever?: PdpGeoRetriever;
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

  return new LocalVersionedRagRetriever().retrieve(request);
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
    "Need answer-ready FAQ intent, customer review language, WebPage/Product description separation, source-supported benefit/effect/HowTo reconstruction, and public wording without internal diagnostic labels.",
    "Use official OpenAI, Google Search Central, Gemini, and Perplexity docs for retrieval mode, embeddings, grounding, structured data, and citation-ready source support guidance."
  ].filter(Boolean).join("\n");
}

export class LocalVersionedRagRetriever implements PdpGeoRetriever {
  async retrieve(request: PdpGeoRetrieverRequest): Promise<PdpGeoRetrievedChunk[]> {
    const chunks = request.documents.flatMap((document) => chunkDocument(document.name, document.content, document.version));
    const queryEmbedding = embedText(request.query);
    const queryTerms = tokenize(request.query);
    const scored = chunks.map((chunk) => {
      const lexicalScore = lexicalSimilarity(queryTerms, tokenize(`${chunk.source} ${chunk.title ?? ""} ${chunk.text}`));
      const semanticScore = cosineSimilarity(queryEmbedding, embedText(chunk.text));
      const boost = retrievalBoost(chunk, request.locale, request.market);
      const score = clamp((lexicalScore * 0.48) + (semanticScore * 0.42) + boost, 0, 1);

      return {
        ...chunk,
        score
      };
    });

    return scored
      .filter((chunk) => chunk.score >= (request.settings.scoreThreshold ?? 0.08))
      .sort((a, b) => b.score - a.score)
      .slice(0, request.settings.maxChunks ?? 8);
  }
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

      return [{
        id: `openai-vector-${index + 1}`,
        source: item.filename ?? "openai-vector-store",
        text,
        kind: kindFromName(item.filename ?? "custom"),
        metadata: item.attributes ?? {},
        score: typeof item.score === "number" ? item.score : 0
      }];
    });
  }
}

function chunkDocument(name: string, content: string, version = "v1"): PdpGeoRagChunk[] {
  const sections = splitMarkdownSections(content);
  return sections.map((section, index) => ({
    id: `${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${index + 1}`,
    source: name,
    title: section.title,
    text: section.text,
    kind: kindFromName(name),
    metadata: {
      version,
      index,
      managed: true
    }
  }));
}

function splitMarkdownSections(content: string): Array<{ title?: string; text: string }> {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith("{")) {
    return [{ title: "JSON terminology map", text: normalized }];
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
    if (paragraph.length > maxLength) {
      if (current.trim()) {
        chunks.push({ title: section.title, text: current.trim() });
        current = "";
      }
      chunks.push(...splitLongParagraph(paragraph, maxLength).map((text) => ({ title: section.title, text })));
      continue;
    }

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
  if (/geo-paper|generative/i.test(name)) {
    return "geo-paper";
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

function retrievalBoost(chunk: PdpGeoRagChunk, locale: PdpGeoLocale, market?: string): number {
  const text = `${chunk.source} ${chunk.title ?? ""} ${chunk.text}`;
  let boost = 0;

  if (chunk.kind === "schema") {
    boost += 0.05;
  }
  if (chunk.kind === "terminology" || chunk.kind === "locale") {
    boost += 0.07;
  }
  if (chunk.kind === "official-docs") {
    boost += 0.06;
  }
  if (chunk.kind === "best-practice" || chunk.kind === "geo-paper") {
    boost += 0.08;
  }
  if (chunk.kind === "eeat" || chunk.kind === "cep") {
    boost += 0.04;
  }
  if (/citation|cite|quotable|answer-ready|faqpage|mainentity|review|customer|webpage\.description|product\.description|claim support|evidence hierarchy|public wording/i.test(text)) {
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

function embedText(text: string): number[] {
  const vector = Array.from({ length: 96 }, () => 0);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}
