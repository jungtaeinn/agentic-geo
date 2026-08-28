import { describe, expect, it } from "vitest";
import {
  extractCitationSentences,
  scoreCitationVisibility,
  scoreImpressionShares,
  zNormalizeScores
} from "../src/citation/metrics";

describe("extractCitationSentences", () => {
  it("splits paragraphs and sentences with global ordering", () => {
    const answer = "First sentence here. Second sentence follows [0].\n\nNew paragraph statement [1][2].";
    const sentences = extractCitationSentences(answer);

    expect(sentences).toHaveLength(3);
    expect(sentences[0]!.paragraphIndex).toBe(0);
    expect(sentences[0]!.citations).toEqual([]);
    expect(sentences[1]!.citations).toEqual([0]);
    expect(sentences[2]!.paragraphIndex).toBe(1);
    expect(sentences[2]!.sentenceIndex).toBe(2);
    expect(sentences[2]!.citations).toEqual([1, 2]);
  });

  it("parses [1][2] chains, [1, 2] groups, and deduplicates repeats", () => {
    const [sentence] = extractCitationSentences("Supported by several sources [0][1] and more [1, 3].");
    expect(sentence!.citations).toEqual([0, 1, 3]);
  });

  it("counts Hangul tokens as content words and drops citation markers", () => {
    const [sentence] = extractCitationSentences("세안 후 즉시 수분 공급 [0].");
    expect(sentence!.wordCount).toBe(5);
  });

  it("does not split Korean sentence-internal decimals", () => {
    const sentences = extractCitationSentences("평점은 4.9점입니다 [0]. 리뷰가 많습니다 [1].");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.citations).toEqual([0]);
  });
});

describe("scoreImpressionShares", () => {
  it("normalizes each impression to a share summing to 1", () => {
    const sentences = extractCitationSentences(
      "Alpha claim with many supporting words in it [0]. Beta short claim [1]. Gamma trailing claim also cited [1]."
    );
    const shares = scoreImpressionShares(sentences, 3);

    for (const metric of [shares.wordpos, shares.word, shares.pos]) {
      expect(metric).toHaveLength(3);
      expect(metric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    }
    expect(shares.wordpos[2]!).toBe(0);
    expect(shares.citedSentenceCount).toBe(3);
    expect(shares.sentenceCount).toBe(3);
  });

  it("weights earlier citations higher in the pos metric", () => {
    const sentences = extractCitationSentences(
      "Early cited sentence [0]. Middle filler sentence without citation. Late cited sentence [1]."
    );
    const shares = scoreImpressionShares(sentences, 2);
    expect(shares.pos[0]!).toBeGreaterThan(shares.pos[1]!);
  });

  it("splits a sentence's credit evenly across multiple citations", () => {
    const sentences = extractCitationSentences("Shared support statement with several words [0][1].");
    const shares = scoreImpressionShares(sentences, 2);
    expect(shares.word[0]!).toBeCloseTo(shares.word[1]!, 10);
    expect(shares.word[0]!).toBeCloseTo(0.5, 10);
  });

  it("ignores hallucinated citation indices but reports them", () => {
    const sentences = extractCitationSentences("Real support [0]. Hallucinated support [7].");
    const shares = scoreImpressionShares(sentences, 2);
    expect(shares.hallucinatedCitations).toEqual([7]);
    expect(shares.word[0]!).toBeCloseTo(1, 10);
    expect(shares.citedSentenceCount).toBe(1);
  });

  it("falls back to a uniform share when nothing is cited (AutoGEO parity)", () => {
    const sentences = extractCitationSentences("No citations at all here. Still nothing.");
    const shares = scoreImpressionShares(sentences, 4);
    expect(shares.wordpos).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(shares.citedSentenceCount).toBe(0);
  });
});

describe("scoreCitationVisibility", () => {
  it("returns the target source's share for all three metrics", () => {
    const answer = "Target source carries this long detailed sentence [1]. Rival gets a short one [0].";
    const score = scoreCitationVisibility(answer, 2, 1);
    expect(score.wordpos).toBeGreaterThan(0.5);
    expect(score.word).toBeGreaterThan(0.5);
    expect(score.shares.sentenceCount).toBe(2);
  });

  it("is deterministic for identical input", () => {
    const answer = "Repeatable statement [0]. Another one [1][2].";
    const first = scoreCitationVisibility(answer, 3, 2);
    const second = scoreCitationVisibility(answer, 3, 2);
    expect(second).toEqual(first);
  });

  it("rejects an out-of-range target index", () => {
    expect(() => scoreCitationVisibility("Text [0].", 2, 5)).toThrow(/outside the source range/);
  });
});

describe("zNormalizeScores", () => {
  it("normalizes to zero mean and unit variance", () => {
    const normalized = zNormalizeScores([1, 2, 3, 4]);
    const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
    expect(mean).toBeCloseTo(0, 10);
    expect(Math.max(...normalized)).toBeGreaterThan(0);
  });

  it("maps zero-variance input to zeros", () => {
    expect(zNormalizeScores([2, 2, 2])).toEqual([0, 0, 0]);
  });

  it("handles empty input", () => {
    expect(zNormalizeScores([])).toEqual([]);
  });
});
