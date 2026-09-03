/**
 * Sentence form, judged by grammar rather than by wording.
 *
 * These rules answer two questions the generator and the copy refiner both
 * have to ask about the same string — "is this a closed sentence?" and "is this
 * an attribute value or a sentence?" — so they live in one place rather than
 * being restated on each side.
 */

/**
 * Sentence-final endings of the polite speech levels (합쇼체/해요체).
 *
 * These are their own syllables, so listing them is the rule. This is the
 * register every Korean composer in this module writes in, which is why it is
 * also the test for whether a source sentence can be published beside them.
 */
/**
 * The polite (해요체) Korean copula endings ("이에요"/"예요"). This is a
 * single source shared by two independent copula checks that must not
 * silently diverge on which endings count as "is-a": final-proofreader's
 * allowed-transformation table (which endings are honorific/style variants
 * of the same copula) and content-planner's description identity-sentence
 * gate (whether a sentence's predicate is a copula at all). They already
 * diverged once (2026-09-01): the identity gate recognized only 습니다체
 * forms (입니다/이다) and dropped a genuinely valid 해요체 identity sentence
 * that the proofreader's own transformation table already treated as a
 * copula. Both modules import this array instead of listing the endings
 * again locally.
 */
export const KOREAN_COPULA_POLITE_PRESENT_ENDINGS = ["이에요", "예요"] as const;

/**
 * Every copula allomorph these modules recognise, longest first so an
 * alternation matches `이었습니다` rather than stopping at `습니다`.
 *
 * Hoisted here for the same reason as the array above: content-planner built
 * this exact list inline, and the metric gate needs it too — a Korean
 * measurement very commonly ends in one (`개선율은 55%입니다`), both to see the
 * unit at all and to recognise the figure as the predicate's complement.
 * Three copies of a closed morphological class is how they drift apart.
 */
export const KOREAN_COPULA_ENDING_FORMS = [
  "이었습니다",
  "였습니다",
  "입니다",
  "이었다",
  "였다",
  "이다",
  ...KOREAN_COPULA_POLITE_PRESENT_ENDINGS
] as const;

export function isKoreanPoliteSentenceEnding(value: string): boolean {
  // 계사 이형태는 위 상수에서 읽는다. 여기에 목록을 따로 적어 두었을 때는
  // `이에요`가 빠져 있어(그 상수는 알고 있었다) `…클렌저이에요`가 미완성으로
  // 읽혔고, 이미 종결된 문장에 종결이 또 덧붙었다.
  const copula = KOREAN_COPULA_POLITE_PRESENT_ENDINGS.join("|");
  return new RegExp(`(?:습니다|합니다|됩니다|입니다|니다|어요|${copula}|돼요|세요|주세요|십시오)$`, "u").test(value.trim());
}

/**
 * Whether the text closes in a Korean sentence-final ending, in either speech
 * level.
 *
 * The plain declarative (해라체) — the register a study report is written in —
 * cannot be listed the way the polite endings can, because it inflects onto the
 * stem: the past `-았/었/였다` surfaces as 났다/했다/됐다/왔다 and the present
 * `-ㄴ다` as 한다/간다/든다, a different syllable for every stem. It is still one
 * closed grammatical class, so it is identified by the morphology instead of by
 * a word list — see {@link isKoreanPlainDeclarativeEnding}.
 *
 * Both errors here are costly and they pull in opposite directions. Missing a
 * real ending reads a well-formed sentence as an unclosed fragment, and callers
 * then reject it or append an ending it already had. Accepting a false one lets
 * an unsegmented image-text panel — which normally ends on a noun — count as a
 * closed assertion and walk through the gate that exists to stop it.
 */
export function isKoreanCompleteSentence(value: string): boolean {
  // The ending is the question, not the terminator. Property values are
  // published with their final period stripped, and the composers add one back
  // when they wrap a fragment, so a text is read the same way with or without.
  const text = value.trim().replace(/[.!?。！？]+$/u, "").trim();
  return isKoreanPoliteSentenceEnding(text) || isKoreanPlainDeclarativeEnding(text);
}

/**
 * A plain-declarative `다`.
 *
 * Every predicate stem can carry it, and the stems are not a closed set: past
 * and present inflect onto the stem (났다/했다/됐다, 한다/된다/먹는다),
 * consonant stems take it directly (높다/많다/없다), and so do vowel stems —
 * the 르/으 irregulars (크다/다르다/빠르다/쓰다/바쁘다) and the productive
 * "-아/어지다" become-construction (부드러워지다/촉촉해지다), which ordinary
 * skincare copy is full of. So the test admits any Hangul stem.
 *
 * That leaves one thing it cannot decide, and the decision is deliberate: a
 * noun ending in 다 (`베이킹 소다`) is indistinguishable from a predicate, and
 * `시험 결과다` is not even a false positive — it is the contracted copula, a
 * real sentence. Trying to separate those by morphology cost two rounds and
 * broke well-formed prose both times, which is the more expensive failure. They
 * are admitted here on purpose. What is excluded is the case morphology does
 * decide: the particles below attach to a noun, so a text ending in one has a
 * noun where a predicate would be.
 *
 * The closure test does not have to carry the blob judgment alone —
 * {@link isUnsegmentedTranscription} pairs it with a signal that reads the
 * figures rather than the ending.
 */
const koreanNounAttachingDaParticlePattern = /(?:마다|보다)$/u;

function isKoreanPlainDeclarativeEnding(text: string): boolean {
  const syllables = [...text];
  if (syllables.at(-1) !== "다" || koreanNounAttachingDaParticlePattern.test(text)) {
    return false;
  }
  const stem = syllables.at(-2)?.charCodeAt(0);
  return stem !== undefined && stem >= 0xac00 && stem <= 0xd7a3;
}


/**
 * The head of a Korean noun phrase — its last word, with any sentence-final
 * punctuation removed.
 *
 * Korean is head-final, so the last word is what the phrase is *about*: in
 * `건조하거나 민감한 피부의 클렌징을 고려하는 고객` everything before `고객`
 * modifies it. Comparing heads is therefore how you tell a rewording from a
 * change of subject, without knowing any of the words involved. Head-final
 * word order is what makes this work, so it is stated for Korean only.
 */
export function koreanPhraseHeadToken(value: string): string {
  const text = value.trim().replace(/[.!?。！？,，·;:]+$/u, "").trim();
  return text.split(/\s+/u).at(-1) ?? "";
}

/**
 * A separator-joined enumeration rather than a single phrase.
 *
 * Head comparison assumes head-final modification — everything before the last
 * word describes it. A list breaks that assumption: its items are coordinate,
 * so it has no single head, and reordering `보타온, 판테놀, 베타인` states exactly
 * the same facts while changing the last word. The shape is read from the
 * separators alone; what the items are never enters into it.
 *
 * A comma between two digits is a thousands separator or a chemical locant
 * (`10,000ppm`, `1,2-헥산디올`) and does not divide a list — the same rule
 * `sanitizeProductSchemaPropertyText` already applies when it splits one.
 */
export function isSeparatorJoinedList(value: string): boolean {
  return /(?<!\d)\s*[,;、·／]|[,;、·／]\s*(?!\d)/u.test(value.trim());
}

/**
 * The noun-phrase form of a value that has to fill an object slot, or
 * undefined when no safe transformation exists.
 *
 * Benefit signals are stored as sentences (`…까지 세정합니다.`) and the FAQ
 * composers put them where a noun goes. `appendKoreanObjectParticle` reads only
 * the final syllable's coda, so it attached `를` and published
 * `…세정합니다를 돕습니다`. The particle function was not wrong; handing it a
 * sentence was.
 *
 * The transformation is grammatical rather than lexical: a 하다-predicate is
 * built on a nominal, so removing its polite declarative ending exposes that
 * nominal (`세정합니다` -> `세정`) whatever the noun happens to be. Predicates
 * outside that family are not guessed at — `줄입니다` would have to become
 * `줄임`, which is not the register this copy is written in — so the function
 * returns undefined and the caller closes the slot. A closed slot costs one
 * fact; a sentence in a noun slot costs the whole answer.
 */
export function koreanObjectSlotPhrase(value: string): string | undefined {
  const text = value.trim().replace(/[.!?。！？]+$/u, "").trim();
  if (!text) {
    return undefined;
  }
  // The ending is not always final. The list formatter joins two benefit
  // signals, so `…세정합니다와 피부 장벽 관리` closes on a noun and the value as
  // a whole never reads as a sentence — testing only the end let the predicate
  // through in the middle. Every position is stripped, and the connective is
  // re-formed from the nominal the strip exposes: `세정합니다와` becomes
  // `세정과`, because the coda that decides 와/과 belongs to the new final
  // syllable rather than to the one it replaced.
  const nominalized = text
    .replace(/(?:해\s*줍니다|합니다)(\s*(?:와|과|및|,))?/gu, (match, tail: string | undefined, offset: number) => {
      if (tail === undefined) {
        return offset + match.length === text.length ? "" : match;
      }
      const connective = tail.trim();
      if (connective !== "와" && connective !== "과") {
        return tail;
      }
      const previous = text.slice(0, offset).trimEnd().at(-1) ?? "";
      return koreanSyllableHasCoda(previous) ? "과" : "와";
    })
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (!nominalized || isKoreanCompleteSentence(nominalized)) {
    return undefined;
  }
  return nominalized;
}

/**
 * Whether a Hangul syllable closes on a consonant.
 *
 * Which of 와/과, 을/를, 은/는 a noun takes is decided by this and nothing else,
 * so the composed-syllable arithmetic is the rule: the 28 final-consonant slots
 * cycle inside each syllable block, and slot 0 is the open syllable.
 */
function koreanSyllableHasCoda(syllable: string): boolean {
  const code = syllable.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) {
    return false;
  }
  return (code - 0xac00) % 28 !== 0;
}
