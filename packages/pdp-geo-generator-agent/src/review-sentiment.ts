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
