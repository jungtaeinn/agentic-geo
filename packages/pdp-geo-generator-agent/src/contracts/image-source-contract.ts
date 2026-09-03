/**
 * Whether a source-supplied image URL can be published.
 *
 * A PDP scrape sometimes hands over a URL the page itself cut short
 * (`.../1145_L.`), and such a value is unusable wherever it lands: it is not a
 * fetchable image, so it cannot illustrate the product or carry provenance for
 * a transcribed sentence.
 *
 * The check is deliberately syntactic. Reachability is a network fact this
 * package never establishes, so the only defect it can name is one visible in
 * the string: something that is not an absolute http(s) URL, or one whose last
 * character is a punctuation mark a path never ends with — the signature of a
 * truncated value rather than a chosen one.
 *
 * The rule lives here because two stages need the same answer. Intake drops the
 * value so it never reaches the graph, and schema validation still checks the
 * graph it is handed, which may come from somewhere other than this pipeline.
 * Two copies of the predicate would let those stages disagree.
 */

/** Punctuation a URL path never ends with; a trailing one marks a cut-short value. */
const truncationPunctuationPattern = /[.,;:]$/;

/** True when the value is an absolute http(s) URL that does not look cut short. */
export function isPublishableImageUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url) && !truncationPunctuationPattern.test(url);
}
