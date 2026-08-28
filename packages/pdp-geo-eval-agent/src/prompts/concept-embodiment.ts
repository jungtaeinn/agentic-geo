/** @fileoverview GEO·CEP·E-E-A-T 컨셉이 공개 문안에 체화되었는지 심사하는 프롬프트. */
import type { EvalDiagnosticsInput, EvalUiLanguage, GeoQualityEvalInput } from "../types";
import { findSchemaNode, getRecordString, getSchemaGraph } from "../quality/internal";

/** 심판 응답 문자열의 언어 지시에 쓰는 라벨. */
const LANGUAGE_LABEL: Record<EvalUiLanguage, string> = {
  ko: "Korean",
  en: "English"
};

interface ExtractedPublicSections {
  productDescription: string;
  webPageDescription: string;
  faq: Array<{ question: string; answer: string }>;
  howToSteps: Array<{ name: string; text: string }>;
  additionalProperties: Array<{ name: string; value: string }>;
}

/**
 * 컨셉 체화(concept embodiment) 심사용 system/user 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 생성된 공개 문안(설명·FAQ·HowTo·additionalProperty)을 주고, GEO(자기완결적
 *   답변 커버리지)·CEP(구매 인과 경로)·E-E-A-T(경험/전문성/권위/신뢰) 세 컨셉이
 *   "실제 문안에 체화되었는지"를 각각 0-100점으로 심사하는 JSON을 돌려받습니다.
 * - 결정적 루브릭(evaluate.ts)과 별개의 선택적 LLM 심판 레이어이며, 키워드 존재가
 *   아니라 문장이 그 기능을 수행하는지로 판단하게 합니다.
 *
 * 공정성 장치(프롬프트가 강제하는 것):
 * - 소스에 애초에 없던 신호(예: 리뷰 없음)를 감점하지 않도록, 생성기가 읽은 것과
 *   같은 소스 신호 요약(presence boolean/count)을 함께 제공합니다.
 * - 개선 제안은 "기존 콘텐츠의 재배치·연결"로만 표현하게 하고, 새 사실 추가 제안은
 *   금지합니다.
 *
 * @param input 심사 대상 JSON-LD와 진단(diagnostics) 입력
 * @param language 심판 응답 문자열의 언어(ko/en)
 * @returns system(판정 기준·공정성 규칙) / user(공개 문안+소스 신호 요약) 프롬프트 쌍
 */
export function buildConceptEmbodimentPrompt(
  input: GeoQualityEvalInput,
  language: EvalUiLanguage
): { system: string; user: string } {
  const sections = extractPublicSections(input.jsonLd);
  const sourceSignals = summarizeSourceSignals(input.diagnostics);
  const languageLabel = LANGUAGE_LABEL[language];

  const system = `You are a strict content auditor for e-commerce product pages. Your job is to judge whether three optimization CONCEPTS are actually embodied in the given public copy — not whether the copy merely exists, and not whether the underlying source data happens to be rich. Score each concept independently, 0-100.

1. GEO concept = self-contained answer coverage. A generative search engine, using ONLY this copy, must be able to answer each of: what the product is; who it is for; how to use it; which key ingredients/technology drive it; what real users experienced. Each answer must exist as one citable, self-contained sentence — not scattered fragments requiring outside inference.

2. CEP concept = closed causal purchase path. The copy must connect, in order: the customer's entry situation -> their need -> how the product's composition addresses it -> the resulting outcome -> why this makes the product the right fit. Ingredients and benefits merely listed side by side, with no causal link between them, do NOT satisfy this concept even when both are present.

3. EEAT concept = four elements, judged independently:
   - Experience: a first-person or attributed account of real usage, not just a benefit claim.
   - Expertise: ingredients/technology explained by FUNCTION (why it works), not just named.
   - Authoritativeness: consistent brand/product identity and terminology, no internal contradictions.
   - Trust: any numeric claim carries its sample size, time period, and measurement method, without overstated wording.

FAIRNESS RULES — you must follow these:
- Judge only whether each concept is embodied IN THE GIVEN COPY. Never penalize the copy for a source signal that was absent to begin with (see "Source signals" in the user message) — if the source has no review data, the absence of an attributed usage account is expected, not a defect.
- Never propose an improvement that would add information not present in the source. Every improvement must be phrased as surfacing, connecting, or restructuring EXISTING content ("surface the existing X", "connect Y to Z"), never "add W".
- Every "missing" entry must point to a concrete source signal that WAS available (per the source-signal summary) but did not make it into the copy. If a concept element has no supporting source signal at all, do not list it as missing.
- Every "embodied"/"missing" entry must quote or closely paraphrase the specific wording it refers to.

Respond with strict JSON only, no prose outside the JSON object, in exactly this shape:
{
  "dimensions": {
    "geo": { "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] },
    "cep": { "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] },
    "eeat": { "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] }
  },
  "summary": string
}
Write every string value in ${languageLabel}.`;

  const user = `Public copy to judge:

### Product description
${sections.productDescription || "(none)"}

### WebPage description
${sections.webPageDescription || "(none)"}

### FAQ
${sections.faq.length > 0
    ? sections.faq.map((item, index) => `${index + 1}. Q: ${item.question}\n   A: ${item.answer}`).join("\n")
    : "(none)"}

### How-to steps
${sections.howToSteps.length > 0
    ? sections.howToSteps.map((step, index) => `${index + 1}. ${step.name ? `${step.name}: ` : ""}${step.text}`).join("\n")
    : "(none)"}

### Additional properties
${sections.additionalProperties.length > 0
    ? sections.additionalProperties.map((prop) => `- ${prop.name}: ${prop.value}`).join("\n")
    : "(none)"}

---
Source signals (for fairness only — never penalize the absence of a signal below, and never invent content beyond what these imply):
${JSON.stringify(sourceSignals, null, 2)}

Return the JSON object and nothing else.`;

  return { system, user };
}

/** 심사 대상 JSON-LD에서 공개 문안 섹션(설명·FAQ·HowTo·속성)만 추려냅니다. */
function extractPublicSections(jsonLd: unknown): ExtractedPublicSections {
  const graph = getSchemaGraph(jsonLd);
  const productNode = findSchemaNode(graph, "Product");
  const webPageNode = findSchemaNode(graph, "WebPage");
  const faqNode = findSchemaNode(graph, "FAQPage");
  const howToNode = findSchemaNode(graph, "HowTo");

  return {
    productDescription: productNode ? getRecordString(productNode, "description").trim() : "",
    webPageDescription: webPageNode ? getRecordString(webPageNode, "description").trim() : "",
    faq: extractFaqPairs(faqNode),
    howToSteps: extractHowToSteps(howToNode),
    additionalProperties: extractAdditionalProperties(productNode)
  };
}

/** FAQPage 노드에서 질문/답변 쌍을 추립니다(불완전한 항목은 제외). */
function extractFaqPairs(faqNode: Record<string, unknown> | undefined): Array<{ question: string; answer: string }> {
  const entities = faqNode?.["mainEntity"];
  if (!Array.isArray(entities)) {
    return [];
  }
  return entities.flatMap((entity) => {
    if (!isRecord(entity)) {
      return [];
    }
    const question = getRecordString(entity, "name").trim();
    const acceptedAnswer = entity["acceptedAnswer"];
    const answer = isRecord(acceptedAnswer) ? getRecordString(acceptedAnswer, "text").trim() : "";
    return question && answer ? [{ question, answer }] : [];
  });
}

/** HowTo 노드에서 단계 이름/본문을 추립니다(본문 없는 단계는 제외). */
function extractHowToSteps(howToNode: Record<string, unknown> | undefined): Array<{ name: string; text: string }> {
  const steps = howToNode?.["step"];
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.flatMap((step) => {
    if (!isRecord(step)) {
      return [];
    }
    const text = getRecordString(step, "text").trim();
    return text ? [{ name: getRecordString(step, "name").trim(), text }] : [];
  });
}

/** Product 노드의 additionalProperty에서 이름/값 쌍을 추립니다. */
function extractAdditionalProperties(productNode: Record<string, unknown> | undefined): Array<{ name: string; value: string }> {
  const raw = productNode?.["additionalProperty"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const name = getRecordString(entry, "name").trim();
    const rawValue = entry["value"];
    const value = typeof rawValue === "string"
      ? rawValue.trim()
      : typeof rawValue === "number"
        ? String(rawValue)
        : "";
    return name && value ? [{ name, value }] : [];
  });
}

/**
 * Fairness inputs summarized from the same normalized-product signals the
 * generator reads — never derived from the copy being judged. Presence
 * booleans/counts only, so the model can distinguish "source lacked this"
 * from "copy dropped this" without seeing (and being biased toward
 * reproducing) the raw source text itself.
 */
function summarizeSourceSignals(diagnostics: EvalDiagnosticsInput): Record<string, boolean | number> {
  const product = diagnostics.normalizedProduct;
  return {
    hasReviewSignal: Boolean(product.reviews?.keywords && product.reviews.keywords.length > 0),
    sourceIngredientCount: product.ingredients?.length ?? 0,
    sourceUsageStepCount: product.usage?.length ?? 0,
    sourceBenefitCount: (product.benefits?.length ?? 0) + (product.effects?.length ?? 0),
    sourceFaqCount: product.faq?.length ?? 0
  };
}

/** 값이 일반 객체인지 검사하는 좁히기(narrowing) 헬퍼. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
