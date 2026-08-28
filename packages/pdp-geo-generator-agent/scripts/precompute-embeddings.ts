/**
 * Offline embedding precompute for the static RAG corpus.
 *
 * Computes real (provider) embeddings for every corpus chunk's contextual
 * retrieval text and writes them to a committed snapshot JSON. At runtime,
 * `createSnapshotBackedPdpGeoEmbedder` serves these vectors with zero network
 * calls and only the query needs a live embedding call.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/precompute-embeddings.ts \
 *     [--model text-embedding-3-small] [--out src/rag/embeddings/embedding-snapshot_v1.json]
 *
 * The snapshot records the model id; switching models requires a full re-run.
 */
import { resolve } from "node:path";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import {
  chunkPdpGeoRagDocument,
  createPdpGeoContextualRetrievalText,
  type PdpGeoRagEmbedder
} from "../src/rag/retrieval";
import {
  createEmptyPdpGeoEmbeddingSnapshot,
  createPdpGeoEmbeddingSnapshotKey,
  savePdpGeoEmbeddingSnapshot
} from "../src/rag/embedding-snapshot";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_OUT = "src/rag/embeddings/embedding-snapshot_v1.json";
const BATCH_SIZE = 64;

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

function createOpenAiEmbedder(apiKey: string, model: string): PdpGeoRagEmbedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, input: texts })
      });
      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
      }
      const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
      const vectors: number[][] = new Array(texts.length).fill(null).map(() => []);
      for (const item of payload.data ?? []) {
        vectors[item.index] = item.embedding;
      }
      return vectors;
    }
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required (offline precompute only; nothing runs at generation time).");
    process.exitCode = 1;
    return;
  }
  const model = readArg("model", process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL);
  const outPath = resolve(process.cwd(), readArg("out", DEFAULT_OUT));
  const embedder = createOpenAiEmbedder(apiKey, model);

  const profile = await readPdpGeoGeneratorRagProfile();
  const texts = new Map<string, string>();
  for (const document of profile.documents) {
    for (const chunk of chunkPdpGeoRagDocument(document.name, document.content, document.version)) {
      const contextualText = createPdpGeoContextualRetrievalText(chunk);
      texts.set(createPdpGeoEmbeddingSnapshotKey(contextualText), contextualText);
    }
  }

  const entries = Array.from(texts.entries());
  console.log(`Embedding ${entries.length} unique corpus chunk(s) with ${model}...`);
  const snapshot = createEmptyPdpGeoEmbeddingSnapshot(model, 0);

  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const vectors = await embedder.embed(batch.map(([, text]) => text));
    batch.forEach(([key], index) => {
      const vector = vectors[index];
      if (Array.isArray(vector) && vector.length > 0) {
        snapshot.entries[key] = vector;
        snapshot.dimensions = vector.length;
      }
    });
    console.log(`  ${Math.min(start + BATCH_SIZE, entries.length)}/${entries.length}`);
  }

  await savePdpGeoEmbeddingSnapshot(outPath, snapshot);
  console.log(`Wrote ${Object.keys(snapshot.entries).length} embedding(s) (${snapshot.dimensions}d, ${model}) to ${outPath}`);
  console.log("Commit the snapshot and wire it at runtime via createSnapshotBackedPdpGeoEmbedder + options.customEmbedder.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
