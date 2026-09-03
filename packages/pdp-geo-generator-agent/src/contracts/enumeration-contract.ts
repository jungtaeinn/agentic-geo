/**
 * Enumeration in published prose, judged by grammar rather than by wording.
 *
 * A property value is a list by design — `Key ingredients` is supposed to name
 * every ingredient. A sentence is not: "A, B, C를 돕습니다" states three things
 * and explains none of them, and an answer engine quoting it learns nothing it
 * can attribute. The reconstruction this contract belongs to asks prose to give
 * each item a role or to narrow to the one item the evidence actually supports.
 *
 * So the rule is about form, not about which items are listed: three or more
 * coordinate items sharing a single predicate, none of them carrying a
 * predicate of its own.
 */
import { isKoreanCompleteSentence } from "./sentence-form-contract";

/**
 * Coordinating separators. A comma between digits is a thousands separator or a
 * chemical locant (`10,000ppm`, `1,2-헥산디올`) and divides nothing.
 *
 * The middle dot is deliberately absent. This corpus uses it for both a real
 * coordination (`보타온·판테놀·베타인`) and a fixed compound noun (`성분·기술`,
 * which then takes a particle as one argument), and no structural signal
 * separates the two — the compound made ordinary copy read as a three-item
 * list. So a run has to carry a comma to count, which misses a dot-only list.
 * That is the safe miss: flagging is what changes published copy.
 */
const coordinateSeparatorPattern = /(?<!\d)\s*[,、／]\s*|\s*[,、／]\s*(?!\d)/u;

/**
 * Korean endings that carry a predicate without closing the sentence.
 *
 * An item that ends in one of these has been given a role — `판테놀이 장벽을
 * 돕고` is a clause, not a bare name — so the run is not a bare enumeration.
 * These are conjunctive endings, a closed grammatical class.
 *
 * Some of these syllables also end ordinary nouns (`광고`, `창고`), which makes
 * the test read a noun as predicated now and then. That error is the safe one:
 * it declines to flag, and flagging is the action that changes published copy.
 */
const koreanConjunctiveEndingPattern = /(?:고|며|면서|지만|어서|아서|므로|는데|은데|하여|해서)$/u;

/**
 * Adverbial case particles.
 *
 * A comma after one of these closes a clause, not a list item: in
 * `…민감한 피부 고객을 위한 제품으로, 콜레스테롤, 지방산을 …` the first comma
 * separates the target clause from the composition, and only the two after it
 * are coordinate. Counting the clause as an item turned a two-item pair into a
 * three-item list. These particles are a closed class.
 */
const koreanAdverbialParticlePattern = /(?:으로|로|에서|에게|에|까지|부터|처럼|보다)$/u;

/**
 * Whether any sentence lists three or more items under one predicate without
 * giving any of them a role.
 *
 * Korean and English are judged by different signals because they mark
 * coordination differently — Korean by sentence-final and conjunctive
 * morphology, English by the serial comma and its coordinator — but both read
 * form only, never which items are listed. Each rule guards on script, so a
 * sentence is judged by exactly one of them and no locale has to be threaded
 * through the callers.
 */
export function hasUnpredicatedEnumeration(
  value: string,
  isExemptSentence?: (sentence: string, index: number) => boolean
): boolean {
  return unpredicatedEnumerationSentence(value, isExemptSentence) !== undefined;
}

/**
 * The sentence that enumerates without roles, if any.
 *
 * A finding has to name the sentence, not the field. When it carried the whole
 * field text, any edit anywhere in that field changed the finding's identity —
 * so a pre-existing enumeration read as a newly introduced issue and the
 * proofreading pass reverted every edit it had made, reporting a reason that
 * was not true. The offending sentence is stable under edits elsewhere.
 */
export function unpredicatedEnumerationSentence(
  value: string,
  isExemptSentence?: (sentence: string, index: number) => boolean
): string | undefined {
  // Per sentence, not per field. A published description is several sentences,
  // and commas from different ones are not one list — reading the field whole
  // turned two ordinary sentences into a phantom enumeration.
  //
  // `isExemptSentence` lets the caller excuse a sentence that lists an
  // inventory rather than claims: what a page carries, or what reviewers
  // mentioned. Those items are the content itself, so there is no role to give
  // them and narrowing would drop what the sentence is for. Which sentences
  // those are depends on the field and on predicates the caller already owns,
  // so the judgment lives there rather than being guessed here.
  return splitIntoSentences(value).find((sentence, index) =>
    !isExemptSentence?.(sentence, index)
    && !reportsAMeasuredOutcome(sentence)
    && (koreanSentenceEnumeratesWithoutRoles(sentence) || englishSentenceEnumeratesWithoutRoles(sentence)));
}

/**
 * Whether the sentence reports a measured outcome.
 *
 * `…100% of participants showed improvement in fine lines, wrinkles,
 * elasticity, and firmness after 6 weeks` lists four items under one predicate
 * and is not the defect: those are the endpoints a study covered, and narrowing
 * the list would drop measured facts, which this reconstruction forbids
 * outright. A benefit or ingredient list carries no figure, so the percentage
 * separates the two without reading a single content word.
 */
function reportsAMeasuredOutcome(sentence: string): boolean {
  return /\d[\d,.]*\s*%/u.test(sentence);
}

function splitIntoSentences(value: string): string[] {
  return value.trim().split(/(?<=[.!?。！？])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

function koreanSentenceEnumeratesWithoutRoles(sentence: string): boolean {
  // A fragment is a property value, not prose. The rule is about sentences.
  if (!isKoreanCompleteSentence(sentence)) return false;

  const items = sentence
    .replace(/[.!?。！？]+$/u, "")
    .split(coordinateSeparatorPattern)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 3) return false;

  // A genitive head closing the run gives the run its role. In `판테놀, 베타인,
  // 보타온의 3종 장벽 보호 성분을 함유한 …` the noun right after the genitive
  // says what the three names are, which is what this contract asks a sentence
  // to do; the items are not bare, they are the members of a named set the
  // source itself writes that way. What stays flagged is the run whose last
  // item only takes an object particle — `A, B, C를 돕습니다` — where nothing
  // names the items at all.
  if (/^\S+의\s+\S/u.test(items[items.length - 1] ?? "")) return false;

  // The last segment carries the shared predicate; the list is the run of bare
  // names immediately before it. Counting from the end rather than requiring
  // every earlier segment to be bare is what lets a sentence open with a clause
  // — `…고객을 위한 클렌저로, 피부 장벽, 세정력, 저자극 세안을 돕습니다` — and
  // still be read as the three-item list it is.
  let coordinateRun = 1;
  for (let index = items.length - 2; index >= 0 && isBareCoordinateItem(items[index] ?? ""); index -= 1) {
    coordinateRun += 1;
  }
  return coordinateRun >= 3;
}

/**
 * Whether a comma-separated segment is a bare name rather than something the
 * sentence has already given a job — a segment carrying its own predicate, or a
 * clause the comma merely closes, is not an item in a list.
 */
function isBareCoordinateItem(item: string): boolean {
  return !isKoreanCompleteSentence(item)
    && !koreanConjunctiveEndingPattern.test(item)
    && !koreanAdverbialParticlePattern.test(item);
}

/**
 * How many coordinate items published prose may carry under one predicate.
 *
 * Two read as a pair — Korean joins them with 와/과 and no comma appears — while
 * three become a list, which is the shape {@link hasUnpredicatedEnumeration}
 * names. Composers that cannot give each item its own role narrow to this many
 * and leave the complete list to the property field, where a list is the point.
 */
export const PROSE_COORDINATE_ITEM_LIMIT = 2;

/**
 * English clause markers.
 *
 * A segment carrying one of these is a clause, not a bare name in a list —
 * these are copulas, auxiliaries, and relativizers, a closed function-word
 * class in the same sense as the Korean particles above. No content word
 * appears here, so no product category can fall out of the rule.
 */
const englishClauseMarkerPattern = /\b(?:is|are|was|were|has|have|had|that|which|because|while|when|after|before)\b/i;

/** A coordinator introducing the last item of a serial list, with or without the Oxford comma. */
const englishSerialCoordinatorPattern = /^(?:and|or)\s+/i;

/** Beyond this a segment is a clause the writer punctuated, not an item in a list. */
const englishCoordinateItemMaxLength = 60;

/**
 * Whether an English sentence closes a serial list of three or more bare items.
 *
 * The signal is the serial comma together with the coordinator before the final
 * item — `A, B, and C` — which is punctuation plus a closed function word, and
 * is exactly how English marks a coordinate list. Sentences with Hangul are left
 * to the Korean rule.
 */
function englishSentenceEnumeratesWithoutRoles(sentence: string): boolean {
  if (/\p{sc=Hangul}/u.test(sentence)) return false;
  const text = sentence.trim();
  if (!/[.!?]$/u.test(text)) return false;

  const items = text
    .replace(/[.!?]+$/u, "")
    .split(coordinateSeparatorPattern)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 3) return false;

  // Without a coordinator the commas are punctuating something else — an
  // apposition or a fronted clause — rather than closing a list.
  const closing = items.at(-1) ?? "";
  if (!englishSerialCoordinatorPattern.test(closing)) return false;

  // The opening segment carries the subject and verb along with the first item
  // ("X includes A"), so it is never bare and is counted rather than tested —
  // requiring it to be bare undercounted every three-item list by one. With the
  // closing item that gives two, so one bare middle item makes three.
  let bareMiddleItems = 0;
  for (let index = items.length - 2; index >= 1 && isBareEnglishCoordinateItem(items[index] ?? ""); index -= 1) {
    bareMiddleItems += 1;
  }
  return bareMiddleItems >= 1;
}

function isBareEnglishCoordinateItem(item: string): boolean {
  return item.length <= englishCoordinateItemMaxLength && !englishClauseMarkerPattern.test(item);
}
