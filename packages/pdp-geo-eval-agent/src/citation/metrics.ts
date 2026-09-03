/**
 * Deterministic citation-visibility metrics ported from AutoGEO
 * (https://github.com/cxcscmu/AutoGEO, ICLR 2026) `geo_score.py`.
 *
 * Given a generative-engine answer that cites indexed sources with `[n]`
 * markers, these functions compute each source's share-of-voice under three
 * impression models:
 *
 * - `word`:    how many answer words each source supports
 * - `pos`:     how early in the answer each source is cited (exponential decay)
 * - `wordpos`: word volume x position decay (headline metric)
 *
 * All three are normalized to a share across the source set, so the reported
 * value for the target source is a citation share-of-voice in [0, 1]. This is
 * intentionally relative: it is robust to answer-length variation and directly
 * comparable between the vanilla and generated counterfactual runs.
 *
 * Everything in this module is pure and deterministic (no LLM, no network) so
 * it is safe to unit-test in CI even though the harness that produces the
 * answers is an opt-in paid tier.
 *
 * Deviation from AutoGEO: word counting keeps any token containing Hangul/CJK
 * characters (Korean words are routinely 1-2 syllables, so AutoGEO's
 * "length > 2" latin heuristic would drop most Korean content words).
 *
 * Deviation from AutoGEO: a citation group that follows terminal punctuation
 * stays with the sentence it cites. The answer prompt asks for the citation to
 * immediately follow each sentence, and engines write it after the period, so
 * splitting on punctuation alone would strand the marker as a wordless
 * sentence and leave the claim itself uncited.
 */

export interface CitationSentence {
  /** Sentence text including its citation markers. */
  text: string;
  /** Zero-based paragraph index within the answer. */
  paragraphIndex: number;
  /** Zero-based global sentence order across the whole answer. */
  sentenceIndex: number;
  /** Number of content-bearing words (see module doc for the CJK rule). */
  wordCount: number;
  /** Source indices cited by this sentence (deduplicated, answer order). */
  citations: number[];
}

export interface ImpressionShares {
  /** Per-source share-of-voice, word volume x position decay. Sums to 1. */
  wordpos: number[];
  /** Per-source share-of-voice, word volume only. Sums to 1. */
  word: number[];
  /** Per-source share-of-voice, position decay only. Sums to 1. */
  pos: number[];
  /** Cited indices outside [0, sourceCount): ignored in scores, surfaced for reports. */
  hallucinatedCitations: number[];
  /** Sentences carrying at least one in-range citation. */
  citedSentenceCount: number;
  /** Total sentences in the answer. */
  sentenceCount: number;
}

export interface CitationVisibilityScore {
  /** Target source's wordpos share (headline metric). */
  wordpos: number;
  /** Target source's word-volume share. */
  word: number;
  /** Target source's position share. */
  pos: number;
  shares: ImpressionShares;
}

/**
 * The `[n]` / `[1, 2]` citation grammar. The sentence splitter and the citation
 * extractor both derive from these sources, so a future grammar change (a range
 * form, say) cannot leave the two disagreeing — a disagreement would orphan
 * markers from their sentences again.
 */
/** The index list inside a group: `0`, `1, 2`, `1; 2`. */
const CITATION_INDEX_LIST_SOURCE = "\\d+(?:\\s*[,;]\\s*\\d+)*";
const CITATION_GROUP_SOURCE = `\\[\\s*(?:${CITATION_INDEX_LIST_SOURCE})\\s*\\]`;
/** A run of groups one sentence may carry: `[0][1]` and `[0] [1]` alike. */
const CITATION_GROUP_RUN_SOURCE = `(?:${CITATION_GROUP_SOURCE})(?:\\s*${CITATION_GROUP_SOURCE})*`;
const TERMINAL_PUNCTUATION_CLASS = "[.!?…。？！]";

/** Same grammar, capturing the index list for extraction. */
const citationGroupPattern = new RegExp(`\\[\\s*(${CITATION_INDEX_LIST_SOURCE})\\s*\\]`, "g");

/**
 * Breaks after terminal punctuation, except where a citation group follows —
 * that marker belongs to the sentence it cites, so the break moves past it.
 *
 * Both alternatives decide before `\s+` consumes anything: a lookahead placed
 * after `\s+` is defeated by greedy backtracking (the engine gives one space
 * back, the next character is a space rather than `[`, and the guard passes),
 * which is exactly how the original defect survives two or more spaces.
 */
const SENTENCE_BOUNDARY_PATTERN = new RegExp(
  `(?<=${TERMINAL_PUNCTUATION_CLASS})(?!\\s*${CITATION_GROUP_SOURCE})\\s+`
    + `|(?<=${TERMINAL_PUNCTUATION_CLASS}\\s*${CITATION_GROUP_RUN_SOURCE})(?!\\s*${CITATION_GROUP_SOURCE})\\s+`,
  "u"
);

/** Splits an answer into ordered sentences with their `[n]` citations. */
export function extractCitationSentences(answer: string): CitationSentence[] {
  const sentences: CitationSentence[] = [];
  const paragraphs = answer.split(/\n{2,}/);
  let sentenceIndex = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const line of paragraph.split(/\n/)) {
      for (const sentence of splitSentences(line)) {
        const text = sentence.trim();
        if (!text) {
          continue;
        }
        sentences.push({
          text,
          paragraphIndex,
          sentenceIndex,
          wordCount: countContentWords(text),
          citations: extractCitationIndices(text)
        });
        sentenceIndex += 1;
      }
    }
  });

  return sentences;
}

/**
 * Computes the three impression shares over `sourceCount` sources.
 * Mirrors AutoGEO's `impression_*_count_simple` trio: a sentence's score is
 * split evenly among its citations, position decays as `e^(-i/(N-1))`, and
 * each metric is normalized to a share (uniform `1/n` when nothing is cited,
 * matching AutoGEO's normalization fallback).
 */
export function scoreImpressionShares(sentences: CitationSentence[], sourceCount: number): ImpressionShares {
  const wordpos = new Array<number>(sourceCount).fill(0);
  const word = new Array<number>(sourceCount).fill(0);
  const pos = new Array<number>(sourceCount).fill(0);
  const hallucinated = new Set<number>();
  let citedSentenceCount = 0;

  const total = sentences.length;
  for (const sentence of sentences) {
    if (sentence.citations.length === 0) {
      continue;
    }
    const positionDecay = total > 1 ? Math.exp(-sentence.sentenceIndex / (total - 1)) : 1;
    const citationSplit = sentence.citations.length;
    let citedInRange = false;

    for (const citation of sentence.citations) {
      if (citation < 0 || citation >= sourceCount) {
        hallucinated.add(citation);
        continue;
      }
      citedInRange = true;
      word[citation] = (word[citation] ?? 0) + sentence.wordCount / citationSplit;
      pos[citation] = (pos[citation] ?? 0) + positionDecay / citationSplit;
      wordpos[citation] = (wordpos[citation] ?? 0) + (sentence.wordCount * positionDecay) / citationSplit;
    }
    if (citedInRange) {
      citedSentenceCount += 1;
    }
  }

  return {
    wordpos: normalizeShares(wordpos),
    word: normalizeShares(word),
    pos: normalizeShares(pos),
    hallucinatedCitations: [...hallucinated].sort((a, b) => a - b),
    citedSentenceCount,
    sentenceCount: total
  };
}

/** Convenience wrapper: target source's share-of-voice for a raw answer. */
export function scoreCitationVisibility(
  answer: string,
  sourceCount: number,
  targetIndex: number
): CitationVisibilityScore {
  if (targetIndex < 0 || targetIndex >= sourceCount) {
    throw new Error(`targetIndex ${targetIndex} is outside the source range [0, ${sourceCount}).`);
  }
  const shares = scoreImpressionShares(extractCitationSentences(answer), sourceCount);
  return {
    wordpos: shares.wordpos[targetIndex] ?? 0,
    word: shares.word[targetIndex] ?? 0,
    pos: shares.pos[targetIndex] ?? 0,
    shares
  };
}

export interface AttributableSection {
  /** Stable section id (e.g. "faq", "description"). */
  id: string;
  /** Section body text used for lexical matching. */
  text: string;
}

export interface CitationSectionAttribution {
  /** Section id, or "other" for cited sentences no section explains. */
  sectionId: string;
  /** Share of the target document's cited weight this section earned (0..1, sums to 1). */
  share: number;
  /** Number of answer sentences attributed to this section. */
  citedSentences: number;
  /** The attributed answer sentences themselves (citation markers stripped), in answer order. */
  sentences: string[];
}

/**
 * Attributes each answer sentence that cites the target document to the
 * document section it most plausibly came from, via deterministic lexical
 * overlap (no LLM). Weighting mirrors the `word` impression (content-word
 * count per sentence), so the shares answer "which section earned the
 * citations". Sentences with no sufficient overlap fall into `"other"`.
 *
 * Korean note: tokens keep their particles (조사), so matching also tries
 * progressively trimmed token tails against the section text.
 */
export function attributeCitationsToSections(
  answer: string,
  targetIndex: number,
  sections: AttributableSection[]
): CitationSectionAttribution[] {
  const citedSentences = extractCitationSentences(answer)
    .filter((sentence) => sentence.citations.includes(targetIndex));
  if (citedSentences.length === 0 || sections.length === 0) {
    return [];
  }

  const haystacks = sections
    .filter((section) => section.text.trim().length > 0)
    .map((section) => ({ id: section.id, haystack: normalizeForMatch(section.text) }));

  const buckets = new Map<string, { weight: number; count: number; sentences: string[] }>();
  let totalWeight = 0;

  for (const sentence of citedSentences) {
    const weight = Math.max(1, sentence.wordCount);
    totalWeight += weight;
    const tokens = extractMatchTokens(sentence.text);

    let bestId = "other";
    let bestScore = 0;
    for (const section of haystacks) {
      const score = sectionOverlapScore(tokens, section.haystack);
      if (score > bestScore) {
        bestScore = score;
        bestId = section.id;
      }
    }
    if (tokens.length === 0 || bestScore < 0.2) {
      bestId = "other";
    }

    const bucket = buckets.get(bestId) ?? { weight: 0, count: 0, sentences: [] };
    bucket.weight += weight;
    bucket.count += 1;
    bucket.sentences.push(stripCitationMarkers(sentence.text));
    buckets.set(bestId, bucket);
  }

  return [...buckets.entries()]
    .map(([sectionId, bucket]) => ({
      sectionId,
      share: Math.round((bucket.weight / totalWeight) * 1000) / 1000,
      citedSentences: bucket.count,
      sentences: bucket.sentences
    }))
    .sort((a, b) => b.share - a.share);
}

function stripCitationMarkers(sentence: string): string {
  return sentence
    .replace(citationGroupPattern, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?…。])/g, "$1")
    .trim();
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function extractMatchTokens(sentence: string): string[] {
  const withoutCitations = sentence.replace(citationGroupPattern, " ");
  return withoutCitations
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => {
      if (!token) {
        return false;
      }
      if (/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
        return token.length >= 2;
      }
      return token.length > 2;
    });
}

function sectionOverlapScore(tokens: string[], haystack: string): number {
  if (tokens.length === 0) {
    return 0;
  }
  let matched = 0;
  for (const token of tokens) {
    if (haystackIncludesToken(haystack, token)) {
      matched += 1;
    }
  }
  return matched / tokens.length;
}

function haystackIncludesToken(haystack: string, token: string): boolean {
  if (haystack.includes(token)) {
    return true;
  }
  // Korean particles ride on the token tail; retry with the tail trimmed.
  if (/[\p{Script=Hangul}]/u.test(token)) {
    for (const trim of [1, 2]) {
      const stem = token.slice(0, token.length - trim);
      if (stem.length >= 2 && haystack.includes(stem)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Z-normalizes heterogeneous score lists so they can be combined into one
 * composite signal (AutoGEO GRPO `_normalize_scores`). A zero-variance list
 * maps to all zeros instead of dividing by zero.
 */
export function zNormalizeScores(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) {
    return values.map(() => 0);
  }
  return values.map((value) => (value - mean) / std);
}

function splitSentences(line: string): string[] {
  // Deterministic splitter: break after terminal punctuation (latin + CJK)
  // followed by whitespace, keeping any citation group that follows with the
  // sentence it cites (see SENTENCE_BOUNDARY_PATTERN). Avoids splitting
  // decimals ("4.9점") because a digit boundary requires whitespace after the
  // period.
  return line.split(SENTENCE_BOUNDARY_PATTERN);
}

function extractCitationIndices(sentence: string): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const match of sentence.matchAll(citationGroupPattern)) {
    for (const token of (match[1] ?? "").split(/[,;]/)) {
      const index = Number.parseInt(token.trim(), 10);
      if (Number.isInteger(index) && !seen.has(index)) {
        seen.add(index);
        indices.push(index);
      }
    }
  }
  return indices;
}

function countContentWords(sentence: string): number {
  const withoutCitations = sentence.replace(citationGroupPattern, " ");
  const tokens = withoutCitations.split(/\s+/).map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  return tokens.filter((token) => {
    if (!token) {
      return false;
    }
    if (/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
      return true;
    }
    return token.length > 2;
  }).length;
}

function normalizeShares(scores: number[]): number[] {
  const sum = scores.reduce((total, score) => total + score, 0);
  if (sum === 0) {
    return scores.map(() => (scores.length === 0 ? 0 : 1 / scores.length));
  }
  return scores.map((score) => score / sum);
}
