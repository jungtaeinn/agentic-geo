import { cleanUsageText } from "./usage-contract";

/**
 * Shared certification-fact contract.
 *
 * The renderer and the validator previously kept separate copies of the
 * atomic certification list; the validator's copy did not recognize the
 * "하이포알러제닉" spelling the renderer normalizes to, so a correct
 * "하이포알러제닉 테스트 완료" value was repaired away and warned about.
 * Both sides now read the same list, so a value the renderer publishes is by
 * construction a value the validator accepts.
 */

/**
 * Sentence function: a measured efficacy result (percentage/fold change tied
 * to a study or test) — evidence copy, never a certification fact.
 */
export function isQuantifiedClinicalResultSentence(value: string): boolean {
  const text = cleanUsageText(value);
  return /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(text)
    && /(?:임상|인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|결과|clinical|study|self[-\s]?assessment|instrumental|participants?|subjects?|women|men|users?)/i.test(text);
}

// Serialized-metadata detection is shared with the evaluation rubric so the
// generator's public-copy gates and the quality gate's penalty read one
// definition. The eval agent owns it (this package depends on the eval agent,
// never the reverse), and this re-export keeps existing import paths stable.
export { containsSerializedMetadata } from "@agentic-geo/pdp-geo-eval-agent";
import { containsSerializedMetadata } from "@agentic-geo/pdp-geo-eval-agent";

/**
 * Text function: one atomic completed-test fact is a short phrase, not a
 * paragraph. Longer candidates mix in benefits, product identity, or joined
 * neighbouring values and are handled by the sentence-level evidence path.
 */
function isAtomicCertificationFactPhrase(value: string): boolean {
  return value.length <= 72 && value.split(/\s+/).filter(Boolean).length <= 9;
}

/**
 * Extracts only atomic completed-test/certification facts from a mixed text.
 * Each entry captures one certification the source explicitly states as
 * completed; benefit copy, metrics, and OCR fragments never survive.
 */
export function selectAtomicFunctionalCertificationValues(value: string, locale: string): string[] {
  if (locale === "ko-KR") {
    const text = value.replace(/\s+/g, " ").trim();
    return [
      /극민감\s*(?:피부\s*)?테스트\s*완료/u.test(text) ? "극민감 피부 테스트 완료" : undefined,
      /민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text) ? "민감 피부 자극 테스트 완료" : undefined,
      /피부과\s*테스트\s*완료/u.test(text) ? "피부과 테스트 완료" : undefined,
      /여드름성\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "여드름성 피부 사용 적합 테스트 완료" : undefined,
      /알러지\s*테스트\s*완료/u.test(text) && !/하이포\s*알러지\s*테스트\s*완료/u.test(text) ? "알러지 테스트 완료" : undefined,
      /인체\s*안자극\s*테스트\s*완료/u.test(text) ? "인체 안자극 테스트 완료" : undefined,
      /소아과\s*피부\s*테스트\s*완료/u.test(text) ? "소아과 피부 테스트 완료" : undefined,
      /피부\s*내성\s*테스트\s*완료/u.test(text) ? "피부 내성 테스트 완료" : undefined,
      /민감\s*성?\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "민감성 피부 사용 적합 테스트 완료" : undefined,
      /민감\s*피부\s*대상\s*사용성\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 사용성 테스트 완료" : undefined,
      /민감\s*피부\s*대상\s*피부\s*자극\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 피부 자극 테스트 완료" : undefined,
      !/민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text)
        && /피부\s*자극\s*테스트\s*완료/u.test(text) ? "피부 자극 테스트 완료" : undefined,
      /저자극\s*테스트\s*완료/u.test(text) ? "저자극 테스트 완료" : undefined,
      /안\s*자극\s*대체\s*시험\s*완료/u.test(text) ? "안자극 대체 시험 완료" : undefined,
      /하이포\s*알러(?:지|제닉)\s*테스트\s*완료/u.test(text) || /하이포알러(?:지|제닉)\s*테스트\s*완료/u.test(text) ? "하이포알러제닉 테스트 완료" : undefined,
      /논코메도제닉\s*테스트\s*완료/u.test(text) ? "논코메도제닉 테스트 완료" : undefined
    ].filter((item): item is string => Boolean(item));
  }

  return value
    .split(/\s*,\s*|[.。]\s*|\s+[-–—]\s+|;\s*/)
    .map(cleanUsageText)
    .filter(Boolean)
    .filter((item) => /(?:use\s*suitability|skin\s*irritation|low\s*irritation|dermatolog|hypoallergenic|non[-\s]?comedogenic|tested)/i.test(item))
    // A completed-test fact states a verification, so it carries a test
    // token. A bare property term ("hypoallergenic") is a benefit, not a
    // certification, and never joins the documented-testing list.
    .filter((item) => /\btest(?:ed|ing|s)?\b/i.test(item))
    .filter((item) => !isQuantifiedClinicalResultSentence(item))
    .filter((item) => !containsSerializedMetadata(item))
    .filter(isAtomicCertificationFactPhrase);
}

/**
 * True when a transcribed sentence adds nothing a typed field does not
 * already carry, and so must not be published as prose.
 *
 * The EXAMPLEDERMA 크림 미스트 PDP image reads "대학병원 피부과에서". OCR returned
 * "휘경보건 피부과에서" at 0.91 confidence, and a clinic that does not exist was
 * published. Neither a confidence score nor a list of institution names can
 * catch that: the next misreading will be a different word.
 *
 * What can be checked is which representation the extractor committed to. It
 * classified this block into `safetyTests` as "피부과 테스트" — that is its
 * interpretation of the evidence, and it is the part a buyer needs. The
 * surrounding transcription is unvetted surface around that interpretation,
 * so republishing it as prose adds risk and no information.
 *
 * A sentence reporting a measured outcome is excluded: there the numbers are
 * the fact, no typed field replaces them, and the description contract asks
 * for the study context that qualifies them.
 */
export function restatesTypedFieldAsRawTranscription(
  value: string,
  typedFacts: string[]
): boolean {
  const text = cleanUsageText(value);
  if (!text || isQuantifiedClinicalResultSentence(text)) {
    return false;
  }
  return typedFacts
    .map((fact) => cleanUsageText(fact))
    .filter((fact) => fact.length >= 2)
    .some((fact) => text.includes(fact) && text.length > fact.length * 2);
}
