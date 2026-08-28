/**
 * Single source of truth for "usage direction" judgments shared by the
 * planner, renderer, copy refiner, and validator.
 *
 * Why this module exists: these predicates previously lived as four divergent
 * copies (generate.ts, validate.ts, copy-refiner.ts, content-planner.ts).
 * The renderer's copy recognized spray/mist application verbs while the
 * validator's copy did not, so a legitimate mist instruction was published
 * and then flagged as non-actionable — a structural false negative that can
 * never be fixed reliably while the copies drift. Every stage must accept and
 * reject usage text by the same contract.
 *
 * Semantics over keyword lists: each predicate documents the sentence
 * FUNCTION it captures (what the customer is told to do, when, with what).
 * The regexes are the deterministic floor for that function — they are a
 * safety fallback and a fast path, not the primary quality judgment. Model
 * passes (content planning, copy refinement, final proofreading) perform the
 * semantic judgment; this contract only guards factual-safety invariants and
 * keeps publish/validate criteria identical.
 */

/**
 * Normalizes raw candidate text before judgment: strips code fences and
 * control characters, collapses whitespace, and removes leading list/Q-A
 * markers so "1. 얼굴에 분사합니다" and "얼굴에 분사합니다" judge identically.
 * Superset of the per-file cleaners it replaces, so it is safe for callers
 * that already pre-clean.
 */
export function cleanUsageText(value: string): string {
  return value
    .replace(/```(?:json)?/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^\s*[-*\u2022]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*(?:Q|A)[.:]\s*/i, "")
    .trim();
}

/**
 * Sentence function: names a concrete application action the customer
 * performs with the product (dispense, spread, pat, rinse, SPRAY/MIST, …).
 * Union of all previous per-file cue sets plus the spray/mist verb family
 * (분사/뿌리다/스프레이/spray/spritz/噴射/吹きかけ) that mist-format products
 * use as their primary application verb.
 */
export function hasProcedureActionCue(value: string): boolean {
  return /(?:덜어|적셔|올려두|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|두드려|흡수(?!감)|마사지|문지르|헹구|헹굽|거품|도포(?!감)|분사(?!력)|뿌려|뿌리(?:세요|십시오|고)|스프레이|마무리(?:해|하세요|합니다|하십시오)|사용(?:해|하세요|합니다|하십시오|할\s*수\s*있)|apply|dispense|spread|smooth|pat|press|absorb|massage|lather|rinse|pump|take|spray|spritz|use\s+as|なじませ|塗布|すすぎ|マッサージ|吹きかけ|噴射)/i.test(value);
}

/**
 * Sentence function: places the action inside a routine moment (morning,
 * after cleansing, last step, …) even when the verb is generic.
 */
export function hasRoutinePlacementCue(value: string): boolean {
  return /(?:아침|저녁|매일|데일리|스킨케어|샤워\s*후|세안\s*후|마지막\s*단계|첫\s*단계|루틴|morning|night|daily|routine|after\s+(?:cleansing|shower)|last\s+step|first\s+step|朝|夜|毎日|スキンケア|洗顔後|最後のステップ)/i.test(value);
}

/**
 * Counts independent procedural signals (amount/tool, action verb, ordering,
 * imperative ending, cadence). Higher = more instruction-shaped.
 */
export function usageProcedureSignalScore(value: string): number {
  const text = cleanUsageText(value);
  return [
    /(?:적당량|소량|충분량|손바닥|손에|화장솜|얼굴|피부결|미온수|물과\s*함께|appropriate amount|small amount|palm|hands?|cotton pad|face|skin|neck|water|適量|手のひら|顔|肌|コットン)/i.test(text) ? 1 : 0,
    hasProcedureActionCue(text) ? 1 : 0,
    /(?:후|뒤|다음|먼저|마지막|단계|순서|때는|then|after|before|next|finally|step|when|後|次|最後)/i.test(text) ? 1 : 0,
    /(?:주세요|줍니다|합니다|하세요|하십시오|바릅니다|흡수시킵니다|헹굽니다|사용할\s*수\s*있|\buse\b|\bapply\b|\bdispense\b|ます|してください)/i.test(text) ? 1 : 0,
    /(?:아침|저녁|매일|데일리|morning|night|daily|twice|once|朝|夜|毎日)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

/**
 * Counts descriptive/marketing signals (benefit, ingredient, product-noun,
 * sensory framing). Higher = more evidence/marketing-shaped.
 */
export function usageDescriptionSignalScore(value: string): number {
  const text = cleanUsageText(value);
  return [
    hasDescriptiveApplicationFrame(text) ? 2 : 0,
    hasSensoryEvaluationFrame(text) ? 2 : 0,
    /(?:케어|개선|도움|효과|효능|추천|위한|민감|건조|보습|수분|장벽|care|benefit|helps?|supports?|improves?|recommended|for\s+\w+|効果|ケア|改善|おすすめ|向け)/i.test(text) ? 1 : 0,
    /(?:성분|원료|캡슐|포뮬러|기술|ingredient|formula|technology|capsule|成分|処方|技術|カプセル)/i.test(text) ? 1 : 0,
    /(?:제품|상품|토너|크림|세럼|로션|클렌저|product|toner|cream|serum|lotion|cleanser|商品|製品|化粧水|クリーム|美容液)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

/**
 * Sentence function: describes what happens AT the moment of use ("바르는
 * 순간", "with each use") — an experience frame, not a direction.
 */
export function hasDescriptiveApplicationFrame(value: string): boolean {
  return /(?:바르는\s*순간|사용(?:할\s*때마다|하는\s*순간)|도포\s*직후|on\s+application|upon\s+application|when\s+(?:used|applied)|with\s+each\s+use|塗った瞬間|使用(?:時|する瞬間)|使うたび)/i.test(value);
}

/**
 * Sentence function: reports texture/finish/test impressions rather than
 * telling the customer to do something.
 */
export function hasSensoryEvaluationFrame(value: string): boolean {
  return /(?:테스트|시험|사용감|마무리감|수분감|보습감|흡수감|끈적임|산뜻|촉촉|느껴지는|진정되는|피부가\s*진정|부드러운|피부결이\s*부드러운|use[-\s]?feel|finish(?:es)?|non[-\s]?sticky|stickiness|fresh\s+feel|dewy|soothing|skin\s+feels?\s+smooth|tested?|sensory|使用感|仕上がり|べたつき|さっぱり|しっとり|うるおい感|なめらか|落ち着|テスト|試験|感じられる)/i.test(value);
}

/**
 * Core contract: the text is a procedural usage instruction — it directs a
 * customer action and its instruction signals outweigh its descriptive ones.
 * This exact function decides both publish (renderer/planner) and validate
 * (validator/refiner) so the two can never disagree again.
 */
export function isProceduralUsageInstruction(value: string): boolean {
  const text = cleanUsageText(value);
  if (!text) {
    return false;
  }
  const conciseImperative = /^(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|remove|leave|spray|spritz)\b/i.test(text)
    && text.length <= 180;
  if (conciseImperative) {
    return true;
  }
  const proceduralScore = usageProcedureSignalScore(text);
  const descriptiveScore = usageDescriptionSignalScore(text);
  if ((hasDescriptiveApplicationFrame(text) || hasSensoryEvaluationFrame(text)) && proceduralScore < 3) {
    return false;
  }
  return (hasProcedureActionCue(text) || hasRoutinePlacementCue(text))
    && proceduralScore >= 2
    && proceduralScore >= descriptiveScore;
}

/**
 * Sentence function: contains an explicit application verb the customer
 * performs (used to tell instructions apart from formula/technology talk).
 * Includes the spray/mist family for mist-format products.
 */
export function hasActionableApplicationVerb(value: string): boolean {
  const text = cleanUsageText(value);
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|spray|spritz)\b|なじませ|塗布|吹きかけ/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))/.test(text);
}

/**
 * Same as {@link hasActionableApplicationVerb} but ignores the generic Korean
 * "바르다" family, for contexts (review-narrative detection) where a bare
 * "발랐어요" is customer voice rather than an instruction.
 */
export function hasActionableApplicationVerbWithoutGenericApply(value: string): boolean {
  const text = cleanUsageText(value);
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|spray|spritz)\b|なじませ|塗布|吹きかけ/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))/.test(text);
}

/**
 * Sentence function: a Korean-language direction the customer can follow
 * (imperative/polite instruction endings around application verbs).
 */
export function hasKoreanInstructionVerb(value: string): boolean {
  const text = cleanUsageText(value);
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해)|사용\s*(?:해|하세요|합니다|하십시오|한다|하시)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
}

export function hasConcreteKoreanUsageAction(value: string): boolean {
  return hasKoreanInstructionVerb(value);
}

/**
 * Planner-grade contract: the text is a single concrete customer action —
 * not a suitability note, not a measured-result claim. Used when deciding
 * whether source usage evidence can become a HowTo step at all.
 */
export function isConcreteUsageAction(value: string): boolean {
  const text = cleanUsageText(value);
  if (!text || text.length < 8 || !/\s/u.test(text)
    || /(?:suitable\s+for|for\s+external\s+use|can\s+be\s+used|daily\s+use|사용할\s*수|사용\s*가능|외용|적합|おすすめ|使用できます)/iu.test(text)) {
    return false;
  }
  if (/(?:%|％|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b|clinical|instrumental|study|test(?:ed)?|result|versus)/iu.test(text)
    && /(?:개선|증가|감소|높|낮|잔존|효과|효능|improv|increase|decrease|higher|lower|retention|effect)/iu.test(text)) {
    return false;
  }
  return /\b(?:apply|spread|massage|rinse|press|pat|dispense|mix|remove|leave|spray|spritz|wash\s+(?:off|with|the|your|face|skin|hands?|product))\b|(?:바르|바릅|발라|도포|펴\s*바르|마사지|헹구|씻|세안|닦|두드|흡수|덜어|섞|제거|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|하고|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))|(?:塗|なじませ|洗|すす|押さえ|取って|混ぜ|落と|吹きかけ|噴射)/iu.test(text)
    || /(?:after\s+(?:cleansing|shower|toner)[^.!?]{0,50}\buse|(?:샤워|세안|토너)\s*후[^.!?。！？]{0,50}사용|(?:洗顔|シャワー|化粧水)後[^.!?。！？]{0,50}使用)/iu.test(text);
}

/**
 * True when the value reads as an unsegmented page/OCR dump rather than one
 * coherent sentence: dense uppercase brand runs, repeated timeline years, or
 * the same token repeated across stitched fragments. Public schema fields
 * (PropertyValue values, FAQ answers, HowTo steps) must never contain such a
 * block, whatever else it also contains.
 */
/**
 * True when the value carries the signature of a stitched marketing-page
 * dump: dense uppercase brand/packshot runs, a routine "Step 1 … Step N"
 * listing, or a run of context-free percent badges ("94% 93% 93%").
 *
 * This is the RIGHT filter for evidence fields (Reported details, efficacy
 * candidates): legitimate clinical evidence repeats test vocabulary and can
 * cite several study periods, so {@link isRawPageTextBlock}'s token-repeat
 * and year-count rules would reject real evidence. Only the marketing-chrome
 * signature separates a page dump from a dense but genuine evidence sentence.
 */
export function isStitchedMarketingPageDump(value: string): boolean {
  const text = cleanUsageText(value);
  if (!text) return false;
  const uppercaseRuns = text.match(/\b[\p{Lu}][\p{Lu}\p{M}'’-]{3,}\b/gu) ?? [];
  if (uppercaseRuns.length >= 6) return true;
  if ((text.match(/(?:\bStep|단계)\s*\d/giu) ?? []).length >= 3) return true;
  return /\d+(?:\.\d+)?\s*[%％]\s+\d+(?:\.\d+)?\s*[%％]\s+\d+(?:\.\d+)?\s*[%％]/u.test(text);
}

export function isRawPageTextBlock(value: string): boolean {
  const text = cleanUsageText(value);
  if (!text) return false;
  const uppercaseRuns = text.match(/\b[\p{Lu}][\p{Lu}\p{M}'’-]{3,}\b/gu) ?? [];
  if (uppercaseRuns.length >= 6) return true;
  if ((text.match(/\b(?:19|20)\d{2}\b/gu) ?? []).length >= 3) return true;
  const tokenCounts = new Map<string, number>();
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }
  return Array.from(tokenCounts.values()).some((count) => count >= 3);
}
