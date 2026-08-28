/**
 * Shared serialized-metadata contract.
 *
 * Text function: serialized machine metadata (metafield key/value dumps,
 * namespaced keys, orphan-colon values, pipe-chained title fields) rather
 * than prose a source states to a reader. Detected by structure, never by a
 * vocabulary list, so unknown platforms and keys are covered the same way.
 *
 * This lives in the eval agent so both sides read one definition: the
 * generator (which must keep such text out of public copy) depends on this
 * package, so the generator re-exports this function rather than keeping a
 * second copy that could drift.
 */
export function containsSerializedMetadata(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  return /\b[\w-]+(?:[._][\w-]+)+\s*:/.test(text)
    || /(?:^|\s):/.test(text)
    || /:\s*:/.test(text)
    || /\s\|\s/.test(text);
}

/**
 * Finds the first serialized-metadata artifact in a public-copy text and
 * returns a short excerpt for reporting, or undefined when the text is clean.
 * URL colons ("https://...") never match: every pattern requires the colon or
 * pipe to sit in a serialized shape (dotted/snake key, whitespace-orphaned
 * colon, doubled colon, or a spaced pipe chain).
 */
export function findSerializedMetadataArtifact(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /\b[\w-]+(?:[._][\w-]+)+\s*:\s*\S{0,24}/u,
    /(?:^|\s)(:{1,2}\s*\S{1,24})/u,
    /\S{1,24}\s*:\s*:\s*\S{0,24}/u,
    /\S[^|\n]{0,32}\s\|\s[^|\n]{0,48}/u
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return (match[1] ?? match[0]).trim().slice(0, 60);
    }
  }
  return undefined;
}
