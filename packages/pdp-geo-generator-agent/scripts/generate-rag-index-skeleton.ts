/**
 * Offline rag-index skeleton generator.
 *
 * Parses the real heading tree of every corpus document, reports coverage
 * against the typed `rag-index.ts`, and prints paste-ready section entries for
 * unindexed headings (with heuristically inferred routing). Deterministic — no
 * LLM, no network. The drift CI test (`tests/rag-index-integrity.test.ts`)
 * catches dead entries; this script closes the other direction by surfacing
 * headings the index does not know yet.
 *
 * Usage:
 *   npx tsx scripts/generate-rag-index-skeleton.ts [--json]
 */
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { createPdpGeoRagIndexSkeleton, renderPdpGeoRagIndexSkeleton } from "../src/rag/index-skeleton";

async function main(): Promise<void> {
  const profile = await readPdpGeoGeneratorRagProfile();
  const skeleton = createPdpGeoRagIndexSkeleton(profile.documents);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(skeleton, null, 2));
    return;
  }

  for (const entry of skeleton) {
    const indexedCount = entry.sections.length - entry.unindexedSectionCount;
    console.log(`${entry.document} [${entry.kind}] — sections indexed ${indexedCount}/${entry.sections.length}${entry.documentIndexed ? "" : " (NO DOCUMENT-LEVEL ENTRY)"}`);
  }

  const rendered = renderPdpGeoRagIndexSkeleton(skeleton);
  if (rendered) {
    console.log("\n--- paste-ready section entries for unindexed headings ---\n");
    console.log(rendered);
  } else {
    console.log("\nAll document headings resolve to typed rag-index routing.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
