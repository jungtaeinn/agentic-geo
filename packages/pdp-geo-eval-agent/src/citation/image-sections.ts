import type { AttributableSection } from "./metrics";

export interface ImageProvenanceSentence {
  text: string;
  imageUrls?: string[];
}

export interface ImageProvenanceEntry {
  fieldPath: string;
  text?: string;
  imageUrls?: string[];
  sentences?: ImageProvenanceSentence[];
}

/**
 * Builds one attributable section per source image from published-copy
 * provenance, so the citation probe can report which image-derived content
 * earned the citations. Sentence-level provenance wins over entry-level;
 * an entry with no image lineage contributes nothing. Deterministic — no
 * LLM calls.
 */
export function buildImageAttributableSections(entries: ImageProvenanceEntry[]): AttributableSection[] {
  const sentencesByImage = new Map<string, string[]>();

  const add = (imageUrls: string[] | undefined, text: string | undefined): void => {
    const trimmed = text?.trim();
    if (!trimmed || !imageUrls || imageUrls.length === 0) return;
    for (const url of imageUrls) {
      if (!url.trim()) continue;
      const bucket = sentencesByImage.get(url) ?? [];
      if (!bucket.includes(trimmed)) bucket.push(trimmed);
      sentencesByImage.set(url, bucket);
    }
  };

  for (const entry of entries) {
    const sentences = entry.sentences ?? [];
    const sentencesWithImages = sentences.filter((s) => s.imageUrls && s.imageUrls.length > 0);
    if (sentencesWithImages.length > 0) {
      for (const sentence of sentencesWithImages) add(sentence.imageUrls, sentence.text);
      continue;
    }
    add(entry.imageUrls, entry.text);
  }

  return Array.from(sentencesByImage.entries()).map(([id, texts]) => ({ id, text: texts.join("\n") }));
}
