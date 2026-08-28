import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PdpGeoRagEmbedder } from "./retrieval";

/**
 * Precomputed embedding snapshot for the static, versioned RAG corpus.
 *
 * The corpus is small and git-managed, so corpus-chunk embeddings are computed
 * offline once (`scripts/precompute-embeddings.ts`) and committed as a JSON
 * snapshot instead of standing up a vector store. At runtime only the query
 * text is unknown: the snapshot-backed embedder serves corpus texts from the
 * file and delegates unseen texts (the query) to an optional live embedder.
 * Without a live query embedder the snapshot alone cannot place the query in
 * the same vector space, so `embed` throws and the local retriever falls back
 * to its deterministic hash embedding — generation never breaks.
 */
export interface PdpGeoEmbeddingSnapshot {
  /** Embedding model identifier; changing the model requires a full re-embed. */
  model: string;
  dimensions: number;
  createdAt: string;
  /** Snapshot key (`fnv1a(text):length`) -> embedding vector. */
  entries: Record<string, number[]>;
}

/** Stable snapshot key for a text (FNV-1a hash plus length, collision-guarded). */
export function createPdpGeoEmbeddingSnapshotKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${Math.abs(hash)}:${text.length}`;
}

export function createEmptyPdpGeoEmbeddingSnapshot(model: string, dimensions: number): PdpGeoEmbeddingSnapshot {
  return {
    model,
    dimensions,
    createdAt: new Date().toISOString(),
    entries: {}
  };
}

/** Vector space the caller intends to compare against at query time. */
export interface PdpGeoEmbeddingSnapshotExpectation {
  model?: string;
  dimensions?: number;
}

/**
 * Loads a snapshot and refuses one that cannot be compared with the query
 * embedder. A cosine similarity between two different models is arithmetic
 * without meaning, so a mismatch has to stop startup rather than quietly
 * reorder retrieval.
 */
export async function loadPdpGeoEmbeddingSnapshot(
  path: string,
  expected: PdpGeoEmbeddingSnapshotExpectation = {}
): Promise<PdpGeoEmbeddingSnapshot> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<PdpGeoEmbeddingSnapshot>;
  if (!parsed || typeof parsed.model !== "string" || typeof parsed.dimensions !== "number" || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error(`Invalid embedding snapshot at ${path}: expected { model, dimensions, createdAt, entries }.`);
  }

  if (expected.model && expected.model !== parsed.model) {
    throw new Error(`Embedding snapshot at ${path} was built with "${parsed.model}" but the query embedder uses "${expected.model}"; re-run the precompute before serving it.`);
  }
  if (expected.dimensions !== undefined && expected.dimensions !== parsed.dimensions) {
    throw new Error(`Embedding snapshot at ${path} declares ${parsed.dimensions} dimensions but the query embedder produces ${expected.dimensions}.`);
  }

  const entries = parsed.entries as Record<string, number[]>;
  const inconsistent = Object.entries(entries).find(([, vector]) => !Array.isArray(vector) || vector.length !== parsed.dimensions);
  if (inconsistent) {
    throw new Error(`Embedding snapshot at ${path} declares ${parsed.dimensions} dimensions but entry "${inconsistent[0]}" holds ${Array.isArray(inconsistent[1]) ? inconsistent[1].length : "a non-vector"}.`);
  }

  return {
    model: parsed.model,
    dimensions: parsed.dimensions,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    entries
  };
}

export async function savePdpGeoEmbeddingSnapshot(path: string, snapshot: PdpGeoEmbeddingSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export interface SnapshotBackedEmbedderOptions {
  /**
   * Live embedder used for texts missing from the snapshot (normally only the
   * retrieval query, one call per request). Must produce vectors in the same
   * space as `snapshot.model`.
   */
  queryEmbedder?: PdpGeoRagEmbedder;
  /** Called once per embed() batch with the number of snapshot misses. */
  onSnapshotMiss?: (missingCount: number, totalCount: number) => void;
}

/**
 * Wraps a precomputed snapshot as a `PdpGeoRagEmbedder` for the retriever's
 * `customEmbedder` hook. Corpus texts resolve from the snapshot with zero
 * network calls; unseen texts delegate to `queryEmbedder` when provided.
 * When neither source can embed a text this throws, which the local retriever
 * treats as a signal to fall back to deterministic hash embeddings.
 */
export function createSnapshotBackedPdpGeoEmbedder(
  snapshot: PdpGeoEmbeddingSnapshot,
  options: SnapshotBackedEmbedderOptions = {}
): PdpGeoRagEmbedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const results: Array<number[] | undefined> = texts.map((text) => snapshot.entries[createPdpGeoEmbeddingSnapshotKey(text)]);
      const missing = results
        .map((vector, index) => (vector ? undefined : index))
        .filter((index): index is number => index !== undefined);

      if (missing.length > 0) {
        options.onSnapshotMiss?.(missing.length, texts.length);
        if (!options.queryEmbedder) {
          throw new Error(
            `Embedding snapshot (${snapshot.model}) is missing ${missing.length}/${texts.length} text(s) and no queryEmbedder is configured; falling back to deterministic local embeddings.`
          );
        }
        const embedded = await options.queryEmbedder.embed(missing.map((index) => texts[index] ?? ""));
        missing.forEach((textIndex, position) => {
          const vector = embedded[position];
          if (Array.isArray(vector) && vector.length > 0) {
            results[textIndex] = vector;
          }
        });
      }

      const resolved = results.map((vector) => vector ?? []);
      if (resolved.some((vector) => vector.length === 0)) {
        throw new Error(`Embedding snapshot (${snapshot.model}) could not resolve every text in the batch; falling back to deterministic local embeddings.`);
      }
      return resolved as number[][];
    }
  };
}
