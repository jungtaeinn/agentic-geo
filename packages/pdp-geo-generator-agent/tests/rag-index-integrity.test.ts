import { describe, expect, it } from "vitest";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { pdpGeoGeneratorRagManifest } from "../src/rag/manifest";
import { findPdpGeoRagSectionEntry, pdpGeoRagIndex } from "../src/rag/rag-index";

/**
 * Manifest/heading drift guard.
 *
 * The typed RAG index routes retrieval boosts, intents, field targets, and
 * policy-rule severity by section heading. When a document evolves (e.g. a v2
 * rewrite with numbered subheadings) without a matching index update, those
 * section entries silently die and every chunk falls back to coarse
 * document-level metadata. These tests fail the build instead.
 */

interface DocumentHeading {
  title: string;
  headingPath: string;
}

function extractHeadings(content: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const trail: string[] = [];
  let inCodeFence = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    const match = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const level = match[1]?.length ?? 1;
    const title = match[2]?.trim() ?? "";
    trail.length = level - 1;
    trail[level - 1] = title;
    headings.push({ title, headingPath: trail.filter(Boolean).join(" > ") });
  }

  return headings;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/g, " ").replace(/\s+/g, " ").trim();
}

function headingMatchesSection(heading: DocumentHeading, sectionHeading: string): boolean {
  const normalizedSection = normalizeHeading(sectionHeading);
  return heading.headingPath.split(">").some((segment) => {
    const normalizedSegment = normalizeHeading(segment);
    return Boolean(normalizedSegment)
      && (normalizedSegment.includes(normalizedSection) || normalizedSection.includes(normalizedSegment));
  });
}

describe("rag-index integrity", () => {
  it("keeps every indexed document loadable from the RAG profile", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const loadedNames = new Set([
      pdpGeoGeneratorRagManifest.analysisPrompt,
      ...profile.documents.map((document) => document.name)
    ]);

    for (const entry of pdpGeoRagIndex) {
      expect(loadedNames, `rag-index references a document that the profile does not load: ${entry.document}`).toContain(entry.document);
    }
  });

  it("has no dead section entries: every indexed heading matches a real document heading path", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const contentByName = new Map<string, string>([
      [pdpGeoGeneratorRagManifest.analysisPrompt, profile.analysisPrompt],
      ...profile.documents.map((document): [string, string] => [document.name, document.content])
    ]);
    const deadSections: string[] = [];

    for (const entry of pdpGeoRagIndex) {
      const content = contentByName.get(entry.document);
      if (!content || entry.sections.length === 0) {
        continue;
      }
      const headings = extractHeadings(content);
      for (const section of entry.sections) {
        const matched = headings.some((heading) => headingMatchesSection(heading, section.heading));
        if (!matched) {
          deadSections.push(`${entry.document} :: "${section.heading}"`);
        }
      }
    }

    expect(deadSections, `Dead rag-index section entries (heading not found in document):\n${deadSections.join("\n")}`).toEqual([]);
  });

  it("resolves section-level routing for the strategic knowledge documents via heading paths", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const strategicDocuments = [
      pdpGeoGeneratorRagManifest.documents.geoResearch,
      pdpGeoGeneratorRagManifest.documents.eeat,
      pdpGeoGeneratorRagManifest.documents.cep,
      pdpGeoGeneratorRagManifest.documents.bestPractice
    ];

    for (const documentName of strategicDocuments) {
      const content = profile.documents.find((document) => document.name === documentName)?.content ?? "";
      const headings = extractHeadings(content).filter((heading) => heading.headingPath.includes(">"));
      expect(headings.length, `${documentName} should expose sub-headings`).toBeGreaterThan(0);

      const resolved = headings.filter((heading) =>
        findPdpGeoRagSectionEntry(documentName, heading.title, heading.headingPath) !== undefined);
      const resolvedRatio = resolved.length / headings.length;

      // Purpose/source-scope style headings may intentionally stay unindexed,
      // but the majority of content sections must resolve to typed routing.
      expect(
        resolvedRatio,
        `${documentName}: only ${resolved.length}/${headings.length} sub-headings resolve to a rag-index section`
      ).toBeGreaterThanOrEqual(0.6);
    }
  });
});
