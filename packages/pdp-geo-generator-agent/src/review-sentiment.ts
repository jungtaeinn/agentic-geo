/**
 * Shared review-polarity guard used by both generation and final validation.
 * Phrase-level exceptions keep positive absence/reduction expressions such as
 * "끈적임이 적은" and "자극 없이" from being misclassified as complaints.
 */
export function isNegativeReviewSignalText(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (!text) {
    return false;
  }
  return /(?:약품\s*냄새|냄새|향(?:이|은)?[^.。！？]{0,24}(?:아쉬|별로|강하|불편)|아쉬|별로|불편|따가|화끈|자극(?!\s*(?:없|없이|적))|트러블(?!\s*(?:없|안|올라오지|올라오지\s*않))|건조하|당김이\s*심|끈적(?!임?(?:이)?\s*(?:없|없이|적))|답답|무거|뻑뻑|실망|문제|(?:효과|개선)(?:를|가|은)?\s*(?:느끼|보|확인)지\s*못|(?:효과|도움)(?:이|가)?\s*(?:없|미미|되지\s*않)|bad|worse|worst|smell|odor|scent|fragrance|irritat|breakout|sticky|greasy|heavy|drying|disappoint|complain|(?:did\s+not|didn't|does\s+not|doesn't)\s+(?:notice|see|feel|help)|no\s+(?:visible\s+)?(?:effect|improvement)|not\s+effective)/iu.test(text);
}

/**
 * Review-level polarity, used to keep FAQ recommendations grounded in reviews
 * that actually recommend the product.
 *
 * `isNegativeReviewSignalText` above judges a short span — a keyword or phrase
 * already pulled out of a review — and is deliberately eager there. Whole
 * review bodies broke it: a five-star review reading "세안 후 바로 뿌리면 건조하지
 * 않고 촉촉해요" contains the complaint cue 건조 inside a negation that turns it
 * into praise, and "자극이나 트러블 없이" puts the absence marker several words
 * after the cues it cancels. Measured against the benchmark fixtures, that
 * judge rejected two of three five-star reviews.
 *
 * So review-level polarity is judged separately, and the difference that
 * matters is negation scope: a complaint cue counts only when nothing cancels
 * it. Korean and Japanese place the canceller after the cue ("자극 없이",
 * "べたつかない"); English places it before ("not sticky", "without irritation").
 */

/** Sentiment cues. Linguistic, never product or benefit vocabulary. */
const COMPLAINT_CUES = /(?:아쉬|별로|불편|따가|화끈|자극|트러블|건조|당김|끈적|답답|무거|뻑뻑|실망|냄새|붉어|가렵|간지럽)|\b(?:irritat|sticky|greasy|heavy|drying|disappoint|breakout|burn|itch|smell|odou?r)/iu;

/**
 * Constructions that cancel a complaint cue that precedes them.
 *
 * Two kinds cancel a cue. Negation says the problem is absent ("자극 없이"), and
 * resolution says the product acts on it ("속건조를 잡아주는") — in both the cue
 * names a problem the reviewer is not complaining about.
 */
const TRAILING_NEGATION = /^[^.!?。！？]{0,14}?(?:없|않|안\s|덜|적(?:은|게|어)|잡아주|개선|완화|해결|줄여|줄이|보완|방지|케어|なく|ない|ません|防|改善)/u;

/** The same two kinds, where the canceller precedes the cue instead. */
const LEADING_NEGATION = /(?:\b(?:no|not|never|without|free\s+of|less|isn'?t|wasn'?t|does\s?n'?t|did\s?n'?t|reduces?|prevents?|relieves?|soothes?|solves?|targets?|tackles?|fights?|combats?)\b|\bnon-)[^.!?]{0,20}$/iu;

/**
 * True when a review body reads as a recommendation rather than a complaint.
 *
 * Absence of an uncancelled complaint is the test, not presence of praise. A
 * praise vocabulary has to keep growing to cover how people actually approve
 * of things — "자극이 적어서 매일 저녁 발라주고 있습니다" recommends the product
 * without a single praise word — and each gap silently drops a usable review.
 *
 * Leaning toward inclusion is safe here because of what a review is allowed to
 * contribute: the buying situation only. Every claim in the answer still comes
 * from official evidence, so a bland review can widen situation coverage but
 * cannot put an unsupported recommendation into public copy.
 */
export function isPositiveReviewBody(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  return text.split(/[.!?。！？\n]+/u).every((clause) => !hasUncancelledComplaint(clause));
}

function hasUncancelledComplaint(clause: string): boolean {
  const cue = new RegExp(COMPLAINT_CUES.source, "giu");
  let match: RegExpExecArray | null;
  while ((match = cue.exec(clause)) !== null) {
    const after = clause.slice(match.index + match[0].length);
    const before = clause.slice(0, match.index);
    if (TRAILING_NEGATION.test(after) || LEADING_NEGATION.test(before)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True when a review recommends the product. A supplied rating is the
 * customer's own verdict and outranks any reading of their prose; the prose is
 * judged only when no rating was captured. Ratings above five are read as a
 * ten-point scale.
 */
export function isPositiveReviewItem(item: { body: string; rating?: number }): boolean {
  if (typeof item.rating === "number" && Number.isFinite(item.rating)) {
    const scaleMax = item.rating > 5 ? 10 : 5;
    return item.rating / scaleMax >= 0.8;
  }
  return isPositiveReviewBody(item.body);
}
