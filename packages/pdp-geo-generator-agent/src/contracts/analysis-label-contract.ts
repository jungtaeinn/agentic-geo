/**
 * The labels this pipeline puts on an evidence reading, and what may be done
 * with them.
 *
 * `확인 지표`, `평가 지표`, `Reported result` are names the generator gives to a
 * measurement it is holding — analysis vocabulary, not anything the product
 * says. The Public Wording Contract keeps them out of published values, and
 * three files needed the same list to do it: the composers strip a label off a
 * source sentence before reusing it as prose, the validator reports one that
 * reached a value, and the refiner rejects a rewrite that reintroduces one.
 *
 * Each of them held its own copy, and the copies were different — four
 * overlapping subsets across seventeen call sites, so a label removed in one
 * place survived in another. This module is the single source.
 *
 * ## Two vocabularies, not one
 *
 * They are not interchangeable, and merging them was the mistake waiting to
 * happen:
 *
 * - {@link INTERNAL_ANALYSIS_LABEL_ALTERNATION} is what may never be published.
 *   `시험 결과` is deliberately absent — it is ordinary Korean for a test
 *   result and legitimate public copy (`…시험 결과로도 확인되나요?`), so
 *   rejecting it would kill correct sentences. The rename at the end of
 *   generation turns an internal label *into* it for exactly that reason.
 * - {@link REPORTING_LEAD_LABEL_ALTERNATION} is what a sentence may not open
 *   with when it is lifted out of evidence and reused as prose. `시험 결과` is
 *   included here, because a fragment beginning `시험 결과: …` reads as a field
 *   dump wherever the words came from.
 *
 * Strip with the second, judge with the first.
 */

/**
 * Internal analysis labels, in every locale the pipeline writes.
 *
 * Written as a regex source rather than an array because several call sites
 * mix it into a larger alternation of their own (a FAQ-noise check also looks
 * for review-language markers, for instance) and would otherwise rebuild the
 * list by hand — which is how the copies drifted in the first place.
 */
export const INTERNAL_ANALYSIS_LABEL_ALTERNATION = [
  "확인\\s*지표",
  "확인\\s*근거",
  "평가\\s*지표",
  "측정\\s*/\\s*평가\\s*결과",
  "측정\\s*결과",
  "reported\\s*results?",
  "consumer\\s*assessment",
  "試験結果",
  "確認指標",
  "確認根拠"
].join("|");

/**
 * Labels a reused evidence sentence may not lead with.
 *
 * The internal set plus `시험 결과`: publishable as a phrase inside a sentence,
 * not as the label a fragment opens with.
 */
export const REPORTING_LEAD_LABEL_ALTERNATION = `${INTERNAL_ANALYSIS_LABEL_ALTERNATION}|시험\\s*결과`;

/**
 * The label a composer writes when it has to wrap a bare reading as a value.
 *
 * A producer and a stripper reading two different lists is how a label survives
 * to publication, so the one label each locale writes is stated here beside the
 * list that removes it. Every one of these appears in
 * {@link INTERNAL_ANALYSIS_LABEL_ALTERNATION} — the test in
 * `analysis-label-vocabulary.test.ts` holds that true.
 */
export const PRIMARY_ANALYSIS_LABEL: Record<"ko-KR" | "ja-JP" | "en-US" | "en-GB", string> = {
  "ko-KR": "확인 지표",
  "ja-JP": "確認指標",
  "en-US": "Reported result",
  "en-GB": "Reported result"
};

/**
 * The English label for a self-assessed reading.
 *
 * Distinct from {@link PRIMARY_ANALYSIS_LABEL}: `Reported result` is what an
 * instrumental or otherwise measured reading is called, and a consumer's own
 * agreement is not that. The property formatter renames this one into the
 * primary label; the composer that knows the method is self-assessment writes
 * it. Both read the name from here.
 */
export const CONSUMER_ASSESSMENT_LABEL = "Consumer assessment";

/**
 * The publishable Korean phrase an internal label becomes on its way out.
 *
 * `시험 결과` is what a reader may see; the internal names are not. The rename
 * happens once, at the property formatter, and only for the Korean labels whose
 * meaning it preserves — a measurement label is not renamed into a test label.
 */
export const PUBLISHABLE_KOREAN_RESULT_PHRASE = "시험 결과";

/** The Korean internal labels the rename above may replace. */
export const RENAMEABLE_KOREAN_LABEL_PATTERN = /확인\s*(?:지표|근거)/gu;

/** `label:` at the head of a value — the shape a field dump takes. */
const labelPrefixPattern = new RegExp(`^(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})\\s*[:：]\\s+`, "iu");

/**
 * `label:` or `label은/는/이/가` anywhere — a label introduced as a field or
 * promoted to the grammatical subject. Both make the sentence about the
 * analysis rather than about the product.
 */
const labelArtifactPattern = new RegExp(`(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})\\s*(?:[:：]|[은는이가]\\s)`, "iu");

/**
 * A label used as a noun phrase of its own — closed by a colon, by a Korean
 * particle, or by the end of the value.
 *
 * For the filters that look anywhere in a value rather than only at its head.
 * `측정 결과` is a label there and ordinary Korean elsewhere: in `수분량 측정
 * 결과 사용 4주 후 30% 증가했습니다` it modifies the noun after it, and reading
 * it as a label threw the sentence away. What makes it a label is that nothing
 * follows it inside its own phrase.
 */
export const LABEL_AS_NOUN_PHRASE_SUFFIX = "\\s*(?:[:：]|[은는이가을를에](?![가-힣])|$)";

/**
 * Every `label:` field dump in a value, for counting them or removing them in
 * place.
 *
 * Global, so it carries `lastIndex` — use it with `match`/`replace`, never with
 * `test`.
 */
export const analysisLabelPrefixesAnywhere = new RegExp(
  `(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})\\s*[:：]\\s*`,
  "giu"
);

/**
 * A leading label that declares itself one — followed by a colon, or by the
 * Korean particle that made it the sentence's subject.
 *
 * The particle needs a right boundary. Without one, the label ran on into the
 * next word and its first syllable was read as the particle: `측정 결과 이마
 * 주름이 …` published as `마 주름이 …`, and `시험 결과 가려움이 …` as
 * `려움이 …`. The artifact test in this module already required that boundary,
 * so the two disagreed.
 *
 * The separator is required, and that is the distinction from
 * {@link leadingBareReportingLabelPattern}. Without it, `시험 결과 보습량이 2배
 * 증가했습니다` loses the attribution the sentence opens with — `시험 결과` there
 * is an adverbial, not a field name, and dropping it changes what the sentence
 * claims. Use this on anything that might be ordinary prose.
 */
export const leadingLabelFieldPattern = new RegExp(
  `^(?:${REPORTING_LEAD_LABEL_ALTERNATION})\\s*(?:[:：]|[은는이가](?=\\s|$))\\s*`,
  "iu"
);

/**
 * A leading label with no separator at all.
 *
 * Only for a value already known to be a label-prefixed fragment — a Korean
 * evidence value the composers wrap, or a transcription whose separator the OCR
 * dropped.
 */
export const leadingBareReportingLabelPattern = new RegExp(
  `^(?:${REPORTING_LEAD_LABEL_ALTERNATION})\\s*(?:[:：]|[은는이가](?=\\s|$))?\\s*`,
  "iu"
);

/**
 * An internal label leading a value, with or without a separator.
 *
 * This is the shape the Korean evidence-value normalizer has always removed:
 * `측정/평가 결과 84.3% 증가` is a label-prefixed fragment whether or not the
 * transcription kept the colon. `시험 결과` is deliberately **not** here —
 * unlike the internal names it is ordinary Korean, and with no separator it is
 * an adverbial whose removal changes what the sentence claims. Use
 * {@link leadingBareReportingLabelPattern} only where the value is known to be
 * a label-prefixed fragment rather than a sentence.
 */
export const leadingInternalLabelPattern = new RegExp(
  `^(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})\\s*(?:[:：]|[은는이가](?=\\s|$))?\\s*`,
  "iu"
);

/** `<context> 기준 <label>: <value>` — an assessment context turned field dump. */
const assessmentContextLabelPattern = new RegExp(
  `^(.{2,140}?)\\s*기준\\s*(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})?\\s*[:：]?\\s*(.+)$`,
  "u"
);

/** True when a value opens with an internal analysis label as a field name. */
export function isAnalysisLabelPrefixed(value: string): boolean {
  return labelPrefixPattern.test(value);
}

/** True when an internal analysis label appears as a field name or as a subject. */
export function hasAnalysisLabelArtifact(value: string): boolean {
  return labelArtifactPattern.test(value);
}

/** Splits `<context> 기준 <label>: <value>` into its context and its value. */
export function matchAssessmentContextLabel(value: string): RegExpMatchArray | null {
  return value.match(assessmentContextLabelPattern);
}
