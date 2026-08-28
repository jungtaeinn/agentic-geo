/**
 * Offline research-source ingestion: fetches the external links listed in the
 * GEO research document and emits evidence-card skeletons for human/LLM
 * distillation into `src/rag/evidence/geo-research-cards_v1.md`.
 *
 * This replaces runtime URL resolution (`rag.resolveUrls`): links are followed
 * once here, offline, and the distilled cards are committed as a versioned
 * corpus file so retrieval never fetches anything at generation time.
 *
 * Usage:
 *   npx tsx scripts/ingest-sources.ts [--document geo-research_v3.md] [--limit 30]
 *
 * Output (stdout): one card skeleton per reachable source with title and a
 * short extract. Review, distill claims with appliesTo field targets and
 * publication status, then merge into the evidence cards document.
 */
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_EXTRACT_CHARS = 1_200;

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

function extractUrls(content: string): string[] {
  const withoutCode = content.replace(/```[\s\S]*?```/g, " ");
  const matches = withoutCode.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return Array.from(new Set(matches.map((url) => url.replace(/[.,;:!?]+$/g, ""))));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|section|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchSource(url: string): Promise<{ title?: string; extract: string } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,text/plain;q=0.9",
        "User-Agent": "pdp-geo-generator-agent-ingest/0.1 (offline evidence-card distillation)"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.text()).slice(0, 400_000);
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    // arXiv abstract pages expose the abstract in a well-known block.
    const abstract = body.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1];
    const extract = htmlToText(abstract ?? body).slice(0, MAX_EXTRACT_CHARS);
    return { title, extract };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const documentName = readArg("document", "geo-research_v3.md");
  const limit = Number.parseInt(readArg("limit", "30"), 10);

  const profile = await readPdpGeoGeneratorRagProfile();
  const document = profile.documents.find((candidate) => candidate.name === documentName);
  if (!document) {
    console.error(`Document not found in RAG profile: ${documentName}`);
    process.exitCode = 1;
    return;
  }

  const urls = extractUrls(document.content).slice(0, Number.isFinite(limit) ? limit : 30);
  console.log(`# Evidence card skeletons from ${documentName} (${urls.length} source link(s))\n`);

  for (const url of urls) {
    const resolved = await fetchSource(url);
    console.log(`### ${resolved?.title ?? "TODO: source title"}\n`);
    console.log(`- Source: ${url} · Status: TODO(peer-reviewed|preprint|draft) · Checked: ${new Date().toISOString().slice(0, 10)}`);
    if (resolved?.extract) {
      console.log(`- Raw extract (distill into claims, do not paste verbatim): ${resolved.extract.replace(/\n+/g, " ").slice(0, 500)}`);
    } else {
      console.log("- Raw extract: (fetch failed — distill manually from the source)");
    }
    console.log("- Claim: TODO. Applies to: TODO(fieldTargets).");
    console.log("- Do not use: TODO.\n");
  }

  console.log("\nMerge distilled cards into src/rag/evidence/geo-research-cards_v1.md and bump the version suffix on breaking changes.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
