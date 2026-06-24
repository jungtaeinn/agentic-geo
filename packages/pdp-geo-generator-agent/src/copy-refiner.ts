import { createPdpGeoContentHtml } from "./generate";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoCopyRefinementRequest,
  PdpGeoCopyRefinementResult,
  PdpGeoCopyRefinementSettings,
  PdpGeoCopyRefiner,
  PdpGeoEvidence,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoSchemaMarkup,
  PdpGeoTokenUsage
} from "./types";

interface CopyRefinementApplication {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  usage?: PdpGeoTokenUsage;
  called: boolean;
  applied: boolean;
}

interface ModelBackedCopyRefinerConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

const maxEvidenceItems = 10;
const maxRagChunks = 8;
const strategicRagKinds = new Set(["geo-research", "geo-paper", "cep", "eeat"]);

export async function refinePdpGeoCopy(
  request: PdpGeoCopyRefinementRequest,
  options: PdpGeoGeneratorOptions
): Promise<CopyRefinementApplication> {
  const resolved = resolveCopyRefiner(options);
  const baseApplication: CopyRefinementApplication = {
    schemaMarkup: request.schemaMarkup,
    content: request.content,
    evidence: [],
    warnings: [],
    called: false,
    applied: false
  };

  if (!resolved.refiner) {
    if (resolved.warning) {
      baseApplication.warnings.push(resolved.warning);
      baseApplication.evidence.push({ field: "copy.refinement", source: "llm", value: `Copy refinement skipped: ${resolved.warning}` });
    }
    return baseApplication;
  }

  try {
    const result = await resolved.refiner.refineCopy(request);
    const applied = applyCopyRefinement(request, result);
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings
    ];
    const evidence = [...applied.evidence];
    const strategicSources = strategicExposureSourceSummary(request);

    if (applied.applied) {
      evidence.push({
        field: "copy.refinement",
        source: "llm",
        value: "Model-backed copy refinement selected AI-exposure-worthy product facts using GEO research, CEP, and E-E-A-T guidance, then rewrote schema/content descriptions without adding unsupported claims."
      });
    } else {
      evidence.push({
        field: "copy.refinement",
        source: "llm",
        value: "Model-backed copy refinement returned no accepted public-copy changes."
      });
    }
    if (strategicSources) {
      evidence.push({
        field: "copy.refinement.strategy",
        source: "rag",
        value: `Strategic copy selection considered GEO research/geo-paper, CEP, and E-E-A-T guidance from: ${strategicSources}`
      });
    }
    for (const warning of warnings) {
      evidence.push({ field: "copy.refinement.warning", source: "llm", value: warning });
    }

    return {
      ...baseApplication,
      schemaMarkup: applied.schemaMarkup,
      content: applied.content,
      evidence,
      warnings,
      usage: result.usage,
      called: true,
      applied: applied.applied
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copy refinement provider failed.";
    return {
      ...baseApplication,
      evidence: [{ field: "copy.refinement", source: "llm", value: `Copy refinement skipped: ${message}` }],
      warnings: [message],
      called: true
    };
  }
}

export class ModelBackedCopyRefiner implements PdpGeoCopyRefiner {
  constructor(private readonly config: ModelBackedCopyRefinerConfig) {}

  async refineCopy(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    switch (this.config.provider) {
      case "openai":
        return this.refineWithOpenAI(request);
      case "gemini":
        return this.refineWithGemini(request);
      case "azure-openai":
        return this.refineWithAzureApi(request);
      case "custom":
      case "mock":
      default:
        return { warnings: [`${this.config.provider} copy refinement provider has no model-backed adapter.`] };
    }
  }

  private async refineWithOpenAI(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for copy refinement.");
    }

    const prompt = createCopyRefinementPrompt(request);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions: prompt.system,
        input: prompt.user
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI copy refinement failed: ${response.status}`);
    }

    const payloadText = await response.text();
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      ...parseCopyRefinementJson(payloadText),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async refineWithGemini(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("GEMINI_API_KEY and GEMINI_MODEL are required for copy refinement.");
    }

    const prompt = createCopyRefinementPrompt(request);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini copy refinement failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      ...parseCopyRefinementJson(rawText),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private async refineWithAzureApi(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for copy refinement.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createCopyRefinementPrompt(request);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Azure copy refinement failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parseCopyRefinementJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function resolveCopyRefiner(options: PdpGeoGeneratorOptions): { refiner?: PdpGeoCopyRefiner; warning?: string } {
  if (options.customCopyRefiner) {
    return { refiner: options.customCopyRefiner };
  }

  const settings = options.copyRefinement;
  const provider = settings?.provider ?? options.provider ?? "mock";
  const explicitEnabled = settings?.enabled;
  const enabled = explicitEnabled ?? (provider !== "mock" && provider !== "custom" && Boolean(settings?.apiKey ?? options.apiKey));

  if (!enabled) {
    return {};
  }
  if (provider === "mock" || provider === "custom") {
    return explicitEnabled
      ? { warning: `${provider} copy refinement requires customCopyRefiner.` }
      : {};
  }

  return {
    refiner: new ModelBackedCopyRefiner({
      provider,
      apiKey: settings?.apiKey ?? options.apiKey,
      model: settings?.model ?? options.model,
      endpoint: settings?.endpoint ?? options.endpoint,
      deployment: settings?.deployment ?? options.deployments?.reasoning ?? options.deployment,
      apiVersion: settings?.apiVersion ?? options.apiVersion
    })
  };
}

function createCopyRefinementPrompt(request: PdpGeoCopyRefinementRequest): { system: string; user: string } {
  return {
    system: [
      "You are a conservative GEO product-copy reasoning agent for structured PDP schema descriptions.",
      "Return strict JSON only: {\"schemaDescriptions\":{\"webPage\":\"\",\"product\":\"\"},\"contentSections\":{\"description\":\"\"},\"warnings\":[]}.",
      "Your job is to use GEO research/geo-paper, CEP, and E-E-A-T guidance to identify product facts, keywords, and source-backed phrases that are likely to be useful in AI answer exposure.",
      "Use selected strategic chunks as the primary task-specific guidance. Use hydrated full RAG documents only as controlled background for missing context, conflict resolution, and policy completeness.",
      "When guidance conflicts, apply this priority: source product evidence first, E-E-A-T trust and claim safety, schema validity, GEO answer-readiness, then CEP/customer phrasing.",
      "Extract those useful facts from the supplied product evidence only, then combine them into natural public product sentences.",
      "Prioritize concrete facts: product type, target concern or customer entry point, differentiating formula/ingredient, measured effect, usage context, and review-intent language.",
      "Use only the supplied product evidence and strategic RAG guidance. Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications.",
      "Preserve numeric claims, study populations, usage instructions, ingredient names, and product names exactly when they appear in evidence.",
      "Respect field evidence contracts: HowTo and usage answers may contain only actionable usage directions; ingredient sections may contain only ingredient/formula/full-INCI evidence; benefit sections may contain only outcomes, effects, review-backed positives, or concise evidence topics.",
      "If a sentence is useful evidence but belongs to a different field, rewrite it only in the correct field and do not move the raw phrase across public fields.",
      "Do not mention the strategy labels in the public copy: no RAG, GEO, geo-paper, CEP, E-E-A-T, schema optimization, citation-ready, OCR, image caption, product shot, pack shot, with text, or in the corner.",
      "Keep the output in the requested locale and make Product.description suitable for schema.org Product.description.",
      "If evidence is insufficient, return the current copy unchanged and explain the limitation in warnings."
    ].join("\n"),
    user: JSON.stringify(createCopyRefinementPayload(request), null, 2)
  };
}

function createCopyRefinementPayload(request: PdpGeoCopyRefinementRequest): Record<string, unknown> {
  const descriptions = readSchemaDescriptions(request.schemaMarkup.jsonLd);
  const strategicChunks = selectStrategicRagGuidanceChunks(request.ragChunks, maxRagChunks);
  return {
    task: "Select AI-exposure-worthy product keywords and sentences from productEvidence, guided by GEO research/geo-paper, CEP, and E-E-A-T. Combine only grounded facts into public PDP description copy.",
    locale: request.locale,
    market: request.market,
    currentCopy: {
      schemaDescriptions: descriptions,
      contentSections: {
        description: request.content.sections.description
      }
    },
    productEvidence: {
      name: request.product.name,
      originalName: request.product.originalName,
      brand: request.product.brand,
      category: request.product.category,
      benefits: request.product.benefits.slice(0, maxEvidenceItems),
      effects: request.product.effects.slice(0, maxEvidenceItems),
      ingredients: request.product.ingredients.slice(0, maxEvidenceItems),
      usage: request.product.usage.slice(0, maxEvidenceItems),
      metrics: request.product.metrics.slice(0, maxEvidenceItems),
      reviewSummary: {
        rating: request.product.reviews.rating,
        reviewCount: request.product.reviews.reviewCount,
        keywords: request.product.reviews.keywords.slice(0, maxEvidenceItems),
        examples: request.product.reviews.items.map((review) => review.body).slice(0, 5)
      },
      sourceTexts: unique(request.product.sourceTexts).slice(0, maxEvidenceItems)
    },
    extractionPriorities: [
      "Choose product facts that directly answer likely generative-search questions.",
      "Prefer source-backed specificity over broad marketing language.",
      "Map CEP/customer-entry-point language to the product's actual target concern, routine moment, or comparison context.",
      "Use E-E-A-T guidance to keep claims verifiable, attributed to page evidence, and free of exaggeration.",
      "Use GEO research guidance to make descriptions answer-ready without exposing internal optimization language."
    ],
    strategicExposureGuidance: strategicChunks.map(formatRagGuidanceChunk),
    strategicFullDocuments: (request.hydratedRagDocuments ?? []).map(formatHydratedRagDocument),
    hydrationPolicy: [
      "Selected chunks are the highest-priority task guidance.",
      "Hydrated full documents are included to prevent missing policy context and to resolve overlaps.",
      "Do not apply any hydrated document example or claim unless the productEvidence supports it.",
      "Do not mention internal strategy labels in public copy."
    ],
    ragGuidance: request.ragChunks.slice(0, maxRagChunks).map((chunk) => ({
      ...formatRagGuidanceChunk(chunk),
      priority: isStrategicExposureChunk(chunk) ? "strategic" : "supporting"
    })),
    reasoning: request.reasoning ? {
      principles: request.reasoning.principles,
      selectedSources: request.reasoning.selectedSources,
      decisions: request.reasoning.decisions.map((decision) => ({
        principle: decision.principle,
        enabled: decision.enabled,
        confidence: decision.confidence,
        rationale: decision.rationale,
        ragSources: decision.ragSources,
        productEvidence: decision.productEvidence
      }))
    } : undefined
  };
}

function applyCopyRefinement(
  request: PdpGeoCopyRefinementRequest,
  result: PdpGeoCopyRefinementResult
): Pick<CopyRefinementApplication, "schemaMarkup" | "content" | "evidence" | "warnings" | "applied"> {
  const warnings: string[] = [];
  const evidence: PdpGeoEvidence[] = [];
  const descriptions = readSchemaDescriptions(request.schemaMarkup.jsonLd);
  const productDescription = acceptRefinedText(
    result.schemaDescriptions?.product ?? result.contentSections?.description,
    descriptions.product ?? request.content.sections.description,
    "Product.description",
    warnings
  );
  const webPageDescription = acceptRefinedText(
    result.schemaDescriptions?.webPage,
    descriptions.webPage,
    "WebPage.description",
    warnings
  );
  const contentDescription = acceptRefinedText(
    result.contentSections?.description ?? productDescription,
    request.content.sections.description,
    "content.sections.description",
    warnings
  );

  const nextProductDescription = productDescription ?? contentDescription;
  const nextContentDescription = contentDescription ?? productDescription;
  let schemaMarkup = request.schemaMarkup;
  let content = request.content;
  let applied = false;

  if (nextProductDescription && nextProductDescription !== descriptions.product) {
    schemaMarkup = writeSchemaDescription(schemaMarkup, "Product", nextProductDescription);
    evidence.push({ field: "schema.Product.description", source: "llm", value: summarizeRefinement(descriptions.product, nextProductDescription) });
    applied = true;
  }

  if (webPageDescription && webPageDescription !== descriptions.webPage) {
    schemaMarkup = writeSchemaDescription(schemaMarkup, "WebPage", webPageDescription);
    evidence.push({ field: "schema.WebPage.description", source: "llm", value: summarizeRefinement(descriptions.webPage, webPageDescription) });
    applied = true;
  }

  if (nextContentDescription && nextContentDescription !== request.content.sections.description) {
    const sections = {
      ...request.content.sections,
      description: nextContentDescription
    };
    content = {
      ...request.content,
      sections,
      html: createPdpGeoContentHtml(sections, request.locale)
    };
    evidence.push({ field: "content.description", source: "llm", value: summarizeRefinement(request.content.sections.description, nextContentDescription) });
    applied = true;
  }

  return {
    schemaMarkup,
    content,
    evidence,
    warnings,
    applied
  };
}

function acceptRefinedText(value: unknown, fallbackValue: string | undefined, field: string, warnings: string[]): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = cleanText(value);
  if (!text || text === fallbackValue) {
    return text || undefined;
  }
  if (text.length < 40) {
    warnings.push(`${field} refinement rejected because it is too short.`);
    return undefined;
  }
  if (text.length > 1800) {
    warnings.push(`${field} refinement rejected because it is too long.`);
    return undefined;
  }
  if (containsInternalOrVisualArtifact(text)) {
    warnings.push(`${field} refinement rejected because it contains internal labels or visual-caption artifacts.`);
    return undefined;
  }

  return text;
}

function readSchemaDescriptions(jsonLd: JsonObject): { webPage?: string; product?: string } {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  return {
    webPage: readDescription(webPage),
    product: readDescription(product)
  };
}

function writeSchemaDescription(schemaMarkup: PdpGeoSchemaMarkup, type: "WebPage" | "Product", description: string): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  for (const node of graph) {
    if (isSchemaNodeOfType(node, type) && isRecord(node)) {
      node.description = description;
    }
  }
  return {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
}

function readDescription(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.description !== "string") {
    return undefined;
  }
  return value.description;
}

function isSchemaNodeOfType(value: unknown, type: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const nodeType = value["@type"];
  return nodeType === type || (Array.isArray(nodeType) && nodeType.includes(type));
}

function summarizeRefinement(before: string | undefined, after: string): string {
  return `Refined from "${truncate(before ?? "", 180)}" to "${truncate(after, 220)}"`;
}

function parseCopyRefinementJson(text: string): PdpGeoCopyRefinementResult {
  const rawText = parseProviderText(text);
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { warnings: ["No parseable copy refinement JSON returned."], rawText };
  }

  const payload = JSON.parse(jsonMatch[0]) as Partial<PdpGeoCopyRefinementResult>;
  return {
    schemaDescriptions: isRecord(payload.schemaDescriptions) ? {
      webPage: typeof payload.schemaDescriptions.webPage === "string" ? payload.schemaDescriptions.webPage : undefined,
      product: typeof payload.schemaDescriptions.product === "string" ? payload.schemaDescriptions.product : undefined
    } : undefined,
    contentSections: isRecord(payload.contentSections) && typeof payload.contentSections.description === "string"
      ? { description: payload.contentSections.description }
      : undefined,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : undefined,
    rawText
  };
}

function isStrategicExposureChunk(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): boolean {
  const kind = String(chunk.kind);
  return strategicRagKinds.has(kind)
    || /geo[-_\s]?(research|paper)|generative|cep|customer entry point|e-e-a-t|eeat/i.test(`${chunk.source} ${chunk.title ?? ""}`);
}

function selectStrategicRagGuidanceChunks(
  chunks: PdpGeoCopyRefinementRequest["ragChunks"],
  limit: number
): PdpGeoCopyRefinementRequest["ragChunks"] {
  const strategicChunks = chunks.filter(isStrategicExposureChunk);
  const selected: PdpGeoCopyRefinementRequest["ragChunks"] = [];
  const selectedKeys = new Set<string>();

  for (const kind of strategicRagKinds) {
    const candidate = strategicChunks.find((chunk) => chunk.kind === kind);
    if (!candidate) {
      continue;
    }
    selected.push(candidate);
    selectedKeys.add(ragGuidanceChunkKey(candidate));
  }

  for (const chunk of strategicChunks) {
    if (selected.length >= limit) {
      break;
    }
    const key = ragGuidanceChunkKey(chunk);
    if (selectedKeys.has(key)) {
      continue;
    }
    selected.push(chunk);
    selectedKeys.add(key);
  }

  return selected;
}

function ragGuidanceChunkKey(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): string {
  return `${chunk.source}:${chunk.title ?? ""}:${chunk.id}`;
}

function formatRagGuidanceChunk(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): Record<string, unknown> {
  return {
    source: chunk.source,
    title: chunk.title,
    kind: chunk.kind,
    intents: chunk.intents ?? [],
    fieldTargets: chunk.fieldTargets ?? [],
    score: chunk.score,
    excerpt: truncate(cleanText(chunk.text), 700)
  };
}

function formatHydratedRagDocument(document: NonNullable<PdpGeoCopyRefinementRequest["hydratedRagDocuments"]>[number]): Record<string, unknown> {
  return {
    source: document.source,
    version: document.version,
    kind: document.kind,
    hydrationMode: document.hydrationMode,
    selectedChunkTitles: document.selectedChunkTitles,
    content: document.content
  };
}

function strategicExposureSourceSummary(request: PdpGeoCopyRefinementRequest): string | undefined {
  const sources = unique(request.ragChunks
    .filter(isStrategicExposureChunk)
    .map((chunk) => chunk.title ? `${chunk.source}#${chunk.title}` : chunk.source))
    .slice(0, 6);
  return sources.length > 0 ? sources.join(", ") : undefined;
}

function parseProviderText(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    return parsed.output_text
      ?? parsed.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n")
      ?? text;
  } catch {
    return text;
  }
}

function tokenUsageFromOpenAi(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactTokenUsage({
    inputTokens: numberField(value.input_tokens) ?? numberField(value.prompt_tokens),
    outputTokens: numberField(value.output_tokens) ?? numberField(value.completion_tokens),
    totalTokens: numberField(value.total_tokens)
  });
}

function tokenUsageFromGemini(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactTokenUsage({
    inputTokens: numberField(value.promptTokenCount),
    outputTokens: numberField(value.candidatesTokenCount),
    totalTokens: numberField(value.totalTokenCount)
  });
}

function tokenUsageFromChatCompletions(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactTokenUsage({
    inputTokens: numberField(value.prompt_tokens),
    outputTokens: numberField(value.completion_tokens),
    totalTokens: numberField(value.total_tokens)
  });
}

function compactTokenUsage(usage: PdpGeoTokenUsage): PdpGeoTokenUsage | undefined {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function containsInternalOrVisualArtifact(value: string): boolean {
  return /\b(RAG|GEO|geo-paper|geo research|CEP|E-E-A-T|EEAT|OCR|schema optimization|citation-ready|image caption|product shot|pack shot|with text|in the corner|person applying|model applying)\b/i.test(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function cleanText(value: string): string {
  return value
    .replace(/```(?:json)?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trim()}...` : value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
