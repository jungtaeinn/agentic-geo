import { assemblePdpGeoRagChunks, inferPdpGeoBrandOverlayDocuments, selectFinalRagChunks } from "../src/agent";
import { pdpGeoGeneratorRagManifest } from "../src/rag/manifest";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import {
  createPdpGeoRagQuery,
  createPdpGeoRagQueryPlan,
  resolvePdpGeoRagSettings,
  type PdpGeoRagEmbedder
} from "../src/rag/retrieval";
import type { PdpGeoRagSettings } from "../src/types";
import type { PdpProductSignal } from "../src/types";
import { evalProducts } from "./fixtures/products";
import { ragEvalGoldens, type RagEvalGolden } from "./goldens";
import {
  aggregateScores,
  scoreRetrieval,
  type AggregateScores,
  type GoldenRetrievalScore,
  type ScoredChunk
} from "./metrics";

/**
 * Deterministic retrieval-benchmark runner.
 *
 * For each golden it mirrors the agent's partial-update path: brand-scope the
 * managed corpus (same rules as agent.ts scopeBrandRagDocuments), build the
 * target-specific subquery via createPdpGeoRagQueryPlan, retrieve top-K with
 * default local settings, and score against the golden's expected anchors.
 * No network, no LLM, no randomness — safe as a CI regression gate.
 */

export interface RagEvalRunResult {
  scores: GoldenRetrievalScore[];
  aggregates: AggregateScores;
  /** Anchors referencing documents/headings that do not exist in the corpus at all (golden bugs). */
  unresolvableAnchors: string[];
}

interface EvalDocument {
  name: string;
  version?: string;
  content: string;
}

export interface RagEvalRunOptions {
  /**
   * Embedding adapter for the retrieval under test. Without one the benchmark
   * measures the deterministic hash space; with one it measures the provider
   * space, which is how a corpus or embedder change is compared before it is
   * promoted into a baseline.
   */
  customEmbedder?: PdpGeoRagEmbedder;
  /** Retrieval settings override, for budget/threshold tuning runs. */
  settings?: PdpGeoRagSettings;
}

export async function runRagEval(
  goldens: RagEvalGolden[] = ragEvalGoldens,
  options: RagEvalRunOptions = {}
): Promise<RagEvalRunResult> {
  const profile = await readPdpGeoGeneratorRagProfile();
  const allDocuments: EvalDocument[] = profile.documents.map((document) => ({
    name: document.name,
    version: document.version,
    content: document.content
  }));

  const scores: GoldenRetrievalScore[] = [];

  for (const golden of goldens) {
    const product = evalProducts[golden.productId];
    const documents = scopeBrandDocumentsForEval(allDocuments, product);
    const plan = createPdpGeoRagQueryPlan(product, golden.locale, golden.market, {
      queryPlanning: { enabled: true, updateTargets: [golden.target] }
    });
    const subquery = plan.queries.find((planned) => planned.target === golden.target);
    const query = subquery?.query ?? createPdpGeoRagQuery(product, golden.locale, golden.market);

    // Retrieval assembly is shared with generation (assemblePdpGeoRagChunks),
    // so coverage passes and boosts stay identical instead of drifting apart.
    const settings = resolvePdpGeoRagSettings(options.settings ?? {});
    const boosted = await assemblePdpGeoRagChunks({
      queryPlan: subquery ? { ...plan, queries: [subquery] } : plan,
      product,
      locale: golden.locale,
      market: golden.market,
      documents,
      settings,
      customEmbedder: options.customEmbedder
    });
    const chunks = selectFinalRagChunks(boosted, settings.maxChunks, {
      brandOverlayDocuments: inferPdpGeoBrandOverlayDocuments(product)
    });

    scores.push(scoreRetrieval(
      golden,
      chunks.map(toScoredChunk),
      boosted.map(toScoredChunk)
    ));
  }

  return {
    scores,
    aggregates: aggregateScores(scores),
    unresolvableAnchors: await findUnresolvableAnchors(goldens, allDocuments)
  };
}

/**
 * Validates that every golden anchor resolves against the full (unscoped)
 * corpus, so typos in goldens fail loudly instead of silently deflating
 * claim recall. Heading anchors are checked against raw document text.
 */
async function findUnresolvableAnchors(goldens: RagEvalGolden[], documents: EvalDocument[]): Promise<string[]> {
  const unresolvable: string[] = [];
  const byName = new Map(documents.map((document) => [normalizePath(document.name), document]));

  for (const golden of goldens) {
    for (const anchor of golden.expectedChunks) {
      const document = byName.get(normalizePath(anchor.document));
      if (!document) {
        unresolvable.push(`${golden.id}: missing document ${anchor.document}`);
        continue;
      }
      if (anchor.heading && !document.content.toLowerCase().includes(anchor.heading.toLowerCase())) {
        unresolvable.push(`${golden.id}: heading "${anchor.heading}" not found in ${anchor.document}`);
      }
    }
  }

  return unresolvable;
}

/** Mirrors agent.ts inferBrandRagSlug. */
function matchBrandSlugForEval(product: PdpProductSignal): "exampleluxe" | "examplederma" | undefined {
  const signal = `${product.brand ?? ""} ${product.name}`.toLowerCase().normalize("NFKC").replace(/\s+/g, "");
  if (/(exampleluxe|예시럭셔리)/.test(signal)) {
    return "exampleluxe";
  }
  if (/(examplederma|예시더마|아예시더마)/.test(signal)) {
    return "examplederma";
  }
  return undefined;
}

/**
 * Mirrors agent.ts scopeBrandRagDocuments (source of truth: that function in
 * src/agent.ts): brand documents are overlays layered on top of the default
 * corpus, so all non-brand documents (best-practice/locale-expression/
 * terminology, etc.) stay loaded regardless of brand match, and
 * `brands/<slug>/` documents are included only for the matched brand. Keep this
 * mirror in sync whenever that function's semantics change.
 */
function scopeBrandDocumentsForEval(documents: EvalDocument[], product: PdpProductSignal): EvalDocument[] {
  const slug = matchBrandSlugForEval(product);

  return documents.filter((document) => {
    const name = normalizePath(document.name);
    if (name.startsWith("brands/")) {
      return Boolean(slug && name.startsWith(`brands/${slug}/`));
    }
    return true;
  });
}

function toScoredChunk(chunk: {
  id?: string;
  source: string;
  title?: string;
  kind?: string;
  intents?: string[];
  text: string;
  metadata?: Record<string, unknown>;
}): ScoredChunk {
  return {
    id: chunk.id,
    source: chunk.source,
    title: chunk.title,
    headingPath: typeof chunk.metadata?.headingPath === "string" ? chunk.metadata.headingPath : undefined,
    kind: chunk.kind,
    intents: chunk.intents ?? [],
    text: chunk.text
  };
}

function normalizePath(name: string): string {
  return name.replace(/\\/g, "/").toLowerCase();
}
