/**
 * How a measured result is written as a Korean sentence.
 *
 * The generator composes these sentences and the validator repairs them, so
 * both sides have to agree on the same two rules. They used to hold private
 * copies that drifted apart; this module is the single source.
 */

/**
 * The direction a measurement moved in.
 *
 * These are change-of-state predicates, not subject matter: they say that a
 * quantity went up, came back, or held, and say nothing about what quantity it
 * was. A new product category brings new things to measure and never a new
 * direction for them to move in, which is why this list is closed where an
 * outcome list is not. It is used to recognise a sentence that already reads as
 * a finished result and to strip the reporting tail off one that does not.
 */
export const KOREAN_METRIC_OUTCOME_PATTERN = "회복|개선|감소|증가|상승|향상|완화|잔존|지속";

/**
 * The subset of {@link KOREAN_METRIC_OUTCOME_PATTERN} that names a rise.
 *
 * A measurement that improved and one that came down are both results, and
 * some copy has to tell them apart — whether a figure is an increase decides
 * how the sentence reads. Stated here as a subset of the one list rather than
 * as a second one, which is how a fifth spelling appeared in `generate.ts`.
 */
export const KOREAN_IMPROVEMENT_DIRECTION_PATTERN = /^(?:개선|증가|향상|회복|상승)$/u;

/**
 * The same directions as {@link KOREAN_METRIC_OUTCOME_PATTERN}, as a matcher
 * over free text and with the English and charge-verb forms alongside.
 *
 * Used where a reading has to decide whether a figure describes a result at
 * all. It is the weaker of the two tests that question has — the structural one
 * asks whether the figure has been attributed, and does not care what moved —
 * and it is kept because a claim the extractor filled as typed fields arrives
 * with a sentence too fragmentary for any attribution reading to pass. Its
 * direction is a field, and this pattern is how the joined text exposes it.
 */
export const METRIC_DIRECTION_PATTERN = new RegExp(
  `(?:${KOREAN_METRIC_OUTCOME_PATTERN}|충전|charge|reach|improv|recover|increase|decrease|reduc|last)`,
  "iu"
);

/**
 * Whether a text names the method that produced a measurement.
 *
 * A figure becomes citable when it says how it was obtained. What varies
 * between markets is the wording, not the fact — so the two scripts are read by
 * one predicate. Three literal copies of this test lived in `generate.ts`, and
 * the population test beside them had already drifted between copies: one knew
 * bare `participants`, another did not, so the same evidence sentence was
 * attributed by one gate and unattributed by the next on the same page.
 */
export function statesStudyMethod(text: string): boolean {
  return /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)/iu.test(text);
}

/**
 * Whether a text names who was measured.
 *
 * Counted people (`30명`, `30 women`) and the noun for the measured group
 * (`대상`, `participants`) both answer it. This is the narrower of the two
 * population readings in the generator — {@link ../generate.ts} also has one
 * that accepts an explicit "not disclosed", which is a different question.
 */
export function statesStudyPopulation(text: string): boolean {
  return /(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|participants?|subjects?)/iu.test(text);
}

/**
 * Whether a text carries any cue that a figure came from an observation.
 *
 * Wider than {@link statesStudyMethod}: a comparison, a before/after, a
 * duration or a named group all qualify, because this decides whether a figure
 * is reportable at all rather than whether it is fully attributed.
 *
 * The generator composes with this test and the validator repairs with it, and
 * they held separate copies that had already diverged — the generator accepted
 * a minutes-scale duration (`10분 후`, `after 30 minutes`) and the validator did
 * not, so a sentence the generator published was then judged to be missing its
 * evidence context. The union of the two is what both now read.
 */
export function statesEvidenceContext(text: string): boolean {
  return /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|측정|평가|임상|in\s*vitro|ex\s*vivo|clinical|study|test|assessment|instrumental|survey|home\s+usage|\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|표본|sample|participants?|subjects?|사용\s*(?:직후|전|후)|도포\s*(?:직후|전|후)|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월|minutes?|weeks?|days?|hours?|months?)\s*(?:후|동안|만에)?|비교|대비|versus|\bvs\.?\b|(?:before|after)\s+(?:use|application)|after\s+\d)/iu.test(text);
}

/**
 * The value+unit tokens a text states, normalized for comparison.
 *
 * Two texts state the same measurement when they state the same figures,
 * whatever words surround them — `…97.6%로 제시됩니다` and `…97.6%로
 * 측정되었습니다` are one measurement in two voices. Comparing rendered
 * sentences instead let the same figure be published twice, so identity is read
 * off the figures.
 *
 * Only units a measurement scale uses are read. A trade quantity (`200g`,
 * `80 mL`) is not a measured result, and length units are deliberately absent:
 * package dimensions and clinical endpoints cannot be told apart by unit.
 */
export function measurementFigures(value: string): Set<string> {
  return new Set((value.match(MEASUREMENT_FIGURE_PATTERN) ?? [])
    .map((figure) => figure.replace(/\s+/gu, "")));
}

/**
 * 측정 규모로 읽는 수치 표기.
 *
 * 단위 계열은 `normalize.ts`의 인식 패턴이 받아들이는 것과 같아야 한다. 다섯
 * 종만 알던 때는 점·등급·㎛·℃·g/m²h 측정이 이 비교에 걸리지 않아, 각주(표본·
 * 기간)가 붙지 않고 같은 수치의 두 어투를 접는 중복 제거도 동작하지 않았다 —
 * 위 독스트링이 막겠다고 선언한 실패가 그 단위들에서 그대로 났다.
 *
 * 거래 수량은 여전히 제외한다(`200g`, `80 mL`). 길이 단위도 그렇다 — 포장
 * 치수와 임상 지표를 단위로는 가를 수 없다. 그러나 ㎛·㎚처럼 포장 치수로 쓰이지
 * 않는 미시 단위는 측정이다.
 *
 * 기간 단위는 넓히지 않는다. 기간을 수치 동일성에 넣으면 각주 귀속의 모호성
 * 판정이 달라져(같은 수치를 설명하는 두 각주가 기간으로 갈린다) 이 함수가 답할
 * 질문이 아닌 것까지 정하게 된다. 기간은 `PERIOD_SEGMENT_PATTERN`이 읽는다.
 */
const MEASUREMENT_FIGURE_PATTERN = new RegExp(
  "\\d+(?:[.,]\\d+)?\\s*(?:"
    + "[%％‰]|℃|℉|[°˚]\\s*[CF]"
    + "|배|점|등급"
    + "|시간"
    + "|ppm|ppb|㎛|μm|µm|㎚|nm|㎍|µg|μg|IU|kcal|Pa"
    + "|g/m²h|g/m2h"
    + "|points?|times|fold|degrees?"
    + ")",
  "giu"
);

/**
 * Whether every figure one text states is also stated by another.
 *
 * This is how one measurement is recognised across two wordings, and three
 * call sites were spelling the set comparison out. An empty figure set never
 * matches: a sentence with no figures states no measurement, so it cannot be
 * the same one as anything.
 */
export function statesOnlyFiguresOf(candidate: string | Set<string>, owner: string | Set<string>): boolean {
  const stated = candidate instanceof Set ? candidate : measurementFigures(candidate);
  const owned = owner instanceof Set ? owner : measurementFigures(owner);
  return stated.size > 0 && owned.size > 0 && [...stated].every((figure) => owned.has(figure));
}

/**
 * Study scope a source footnote states: who was tested, over what period, with
 * what caveat.
 *
 * These are the fields a measured claim may not be published without, and a
 * compressed OCR panel states them once for the figures it annotates rather
 * than on each figure. Each is recognised by its own closed form — a count of
 * people, a labelled date range, a variability note — never by product
 * vocabulary.
 */
export interface ReportedStudyScope {
  sample?: string;
  period?: string;
  caveat?: string;
}

/**
 * A count of people, with the qualifier the source attached to it.
 *
 * `인` needs a right boundary. Without one it read the day of a date followed
 * by a method noun — `2024.03.29 인체적용시험` — as the sample `29 인`, and the
 * leftmost match then beat the real `22명 대상` later in the same footnote. `명`
 * needs no such guard: no word begins with it.
 */
const samplePattern = /(?:만\s*\d{1,3}\s*~\s*\d{1,3}\s*세[^/|,\n]{0,20})?\d{1,4}\s*(?:명|인(?![가-힣]))(?:\s*(?:대상|참여|이상))?/u;

/** The same count, but only where the source qualified it as the tested group. */
const qualifiedSamplePattern = new RegExp(samplePattern.source.replace("(?:\\s*(?:대상|참여|이상))?", "\\s*(?:대상|참여|이상)"), "u");
/** A test period the source labelled as one. */
const periodPattern = /(?:시험|측정|조사|평가|사용)\s*기간\s*[:\s]*\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}/u;
/** A note that the result varies between people. */
const caveatPattern = /개인\s*차(?:가)?\s*(?:있음|있습니다|있을\s*수\s*있습니다|존재)/u;

/**
 * Reads the study scope out of one footnote segment.
 *
 * Returns nothing when the segment states none of the three, which is what
 * keeps an ordinary sentence from being read as a footnote.
 */
export function readReportedStudyScope(segment: string): ReportedStudyScope | undefined {
  // A qualified count wins over a bare one wherever it sits: `1인 1회 사용 /
  // 여성 32명 대상` states the tested group once, and the leftmost match is not
  // it. Only when nothing is qualified does a bare count stand.
  const sample = (segment.match(qualifiedSamplePattern) ?? segment.match(samplePattern))?.[0]?.trim();
  const period = segment.match(periodPattern)?.[0]?.trim();
  const caveat = segment.match(caveatPattern)?.[0]?.trim();
  return sample || period || caveat ? { sample, period, caveat } : undefined;
}

/**
 * Which figures a compressed panel's footnote annotates.
 *
 * A footnote in a product panel explains the figures printed above it, and the
 * next footnote begins the next panel. So each footnote's scope is the run of
 * figures between it and the previous one — reading order, not vocabulary, and
 * therefore no product category can fall out of the rule.
 *
 * The reading is an inference from order, and OCR order is not a guarantee of
 * layout. It is taken deliberately, because the alternative is to publish a
 * measured result with no tested population at all, which the Evidence Routing
 * Contract forbids outright.
 */
export function annotatedFigureScopes(block: string): Array<{ scope: ReportedStudyScope; figures: Set<string> }> {
  const marks = [samplePattern, periodPattern, caveatPattern]
    .flatMap((pattern) => {
      const global = new RegExp(pattern.source, `${pattern.flags}g`);
      return [...block.matchAll(global)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
    })
    .sort((left, right) => left.start - right.start);
  // Marks that sit in one slash-joined run are one footnote, not three. The
  // gap between them carries only the run's own glue, so a short separator
  // merges and a sentence of prose does not.
  const footnotes: Array<{ start: number; end: number }> = [];
  for (const mark of marks) {
    const open = footnotes.at(-1);
    // The gap between two marks of one footnote carries only the run's own
    // glue, so what separates footnotes is a measured figure — the next panel
    // begins with one. A length cutoff split a footnote whose institution name
    // was long, dropping the period and caveat with it.
    if (open && mark.start >= open.end && measurementFigures(block.slice(open.end, mark.start)).size === 0) {
      open.end = Math.max(open.end, mark.end);
      continue;
    }
    if (open && mark.start < open.end) {
      open.end = Math.max(open.end, mark.end);
      continue;
    }
    footnotes.push({ ...mark });
  }

  let previousEnd = 0;
  return footnotes.flatMap((footnote) => {
    const annotated = block.slice(previousEnd, footnote.start);
    const scope = readReportedStudyScope(block.slice(footnote.start, footnote.end));
    previousEnd = footnote.end;
    const figures = measurementFigures(annotated);
    return scope && figures.size > 0 ? [{ scope, figures }] : [];
  });
}
