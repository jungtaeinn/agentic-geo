import type { EvalContentSections, EvalUiLanguage } from "../types";
import type { CitationProbeResult } from "../citation/probe";
import type { GeoQualityEvaluation } from "../quality/evaluate";
import {
  buildProbeSafetyNotes,
  formatPctDelta,
  formatSectionAttribution,
  getEvaluationSuiteCopy,
  probeQueryOutcome,
  shareToPct
} from "../quality/suite";

/**
 * Copy-paste LLM improvement prompts. Pasting the output into an LLM (e.g.
 * Claude Code) yields diagnosis-grounded fixes, closing the improve ->
 * regenerate -> re-evaluate loop. Hard guardrail baked into both prompts:
 * never invent claims absent from the provided content.
 */

export interface QualityPromptContext {
  productName: string;
  contentSections: EvalContentSections;
  jsonLd: unknown;
}

export interface ProbePromptContext {
  productName: string;
  contentSections: EvalContentSections;
}

export function formatContentSectionsForPrompt(sections: EvalContentSections, language: EvalUiLanguage): string {
  const labels: Array<[string, string, string]> = [
    ["productName", "상품명", "Product name"],
    ["description", "설명", "Description"],
    ["quickFacts", "퀵 팩트", "Quick facts"],
    ["benefits", "효능", "Benefits"],
    ["ingredients", "성분", "Ingredients"],
    ["howToUse", "사용법", "How to use"],
    ["faq", "FAQ", "FAQ"]
  ];
  return labels
    .map(([key, ko, en]) => {
      const value = sections[key as keyof typeof sections];
      return value.trim() ? `### ${language === "ko" ? ko : en}\n${value.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function formatQualityLlmPrompt(
  context: QualityPromptContext,
  evaluation: GeoQualityEvaluation,
  language: EvalUiLanguage
): string {
  const productName = context.productName;
  const dimensionBlocks = evaluation.dimensions.map((dimension) => [
    `### ${dimension.label} — ${dimension.score}/100`,
    dimension.improvements.length > 0
      ? `${language === "ko" ? "개선점" : "Improvements"}:\n${dimension.improvements.map((item) => `- ${item}`).join("\n")}`
      : "",
    dimension.evidence.length > 0
      ? `${language === "ko" ? "평가 근거" : "Evidence"}:\n${dimension.evidence.map((item) => `- ${item}`).join("\n")}`
      : ""
  ].filter(Boolean).join("\n")).join("\n\n");
  const validationBlock = evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0
    ? `\n## ${language === "ko" ? "검증 경고" : "Validation warnings"}\n${[...evaluation.validationDetails, ...evaluation.validationImprovements].map((item) => `- ${item}`).join("\n")}\n`
    : "";
  const sectionsText = formatContentSectionsForPrompt(context.contentSections, language);
  const jsonLd = JSON.stringify(context.jsonLd, null, 2);

  if (language === "ko") {
    return `당신은 GEO(생성형 엔진 최적화) 콘텐츠 개선 어시스턴트입니다.
아래는 상품 "${productName}"의 PDP에서 자동 생성된 schema.org JSON-LD·콘텐츠와 자동 품질 진단 결과입니다.

## 작업
1. "개선점"을 우선순위대로 해결하는 구체적인 수정안을 제시하세요. 수정 전/후를 문장 또는 JSON-LD 필드 단위로 보여주세요.
2. 절대 규칙: 아래 콘텐츠와 JSON-LD에 없는 효능·수치·성분·인증·리뷰를 새로 만들지 마세요. 기존 사실 범위 안에서 표현과 구조만 개선합니다.
3. 각 수정안이 어떤 진단 항목(GEO/CEP/E-E-A-T/검증 경고)을 해결하는지 명시하세요.

## 품질 진단 (총점 ${evaluation.overallScore}/100)
${dimensionBlocks}
${validationBlock}
## 현재 콘텐츠 섹션
${sectionsText}

## 현재 JSON-LD
\`\`\`json
${jsonLd}
\`\`\`
`;
  }
  return `You are a GEO (generative engine optimization) content improvement assistant.
Below are the auto-generated schema.org JSON-LD and content for the product "${productName}", together with an automated quality diagnosis.

## Tasks
1. Propose concrete fixes that resolve the "Improvements" in priority order, showing before/after at the sentence or JSON-LD field level.
2. Hard rule: never invent benefits, figures, ingredients, certifications, or reviews that are absent from the content and JSON-LD below. Improve wording and structure only within the existing facts.
3. State which diagnosis item (GEO/CEP/E-E-A-T/validation warning) each fix resolves.

## Quality diagnosis (overall ${evaluation.overallScore}/100)
${dimensionBlocks}
${validationBlock}
## Current content sections
${sectionsText}

## Current JSON-LD
\`\`\`json
${jsonLd}
\`\`\`
`;
}

export function formatProbeLlmPrompt(
  context: ProbePromptContext,
  probe: CitationProbeResult,
  language: EvalUiLanguage
): string {
  const suite = getEvaluationSuiteCopy(language);
  const productName = context.productName;
  const priorityTag = language === "ko" ? " · 우선 개선 대상" : " · fix first";
  const queryLines = probe.queries.map((query) => {
    const outcome = probeQueryOutcome(query.delta.wordpos);
    const tag = suite.outcomeLabels[outcome] ?? outcome;
    const priority = outcome === "improved" ? "" : priorityTag;
    const attribution = query.sectionAttribution && query.sectionAttribution.length > 0
      ? ` · ${suite.attributionLabel}: ${formatSectionAttribution(query.sectionAttribution, suite)}`
      : "";
    return `- [${tag}${priority}] "${query.query}" — ${shareToPct(query.vanilla.wordpos)}% → ${shareToPct(query.generated.wordpos)}% (Δ${formatPctDelta(query.delta.wordpos)})${attribution}`;
  }).join("\n");
  const overallAttributionLine = probe.sectionAttribution && probe.sectionAttribution.length > 0
    ? `\n${suite.overallAttributionLabel}: ${formatSectionAttribution(probe.sectionAttribution, suite)}`
    : "";
  const safetyLines = buildProbeSafetyNotes(probe, suite).map((note) => `- ${note}`).join("\n");
  const sectionsText = formatContentSectionsForPrompt(context.contentSections, language);

  if (language === "ko") {
    return `당신은 AI 검색(생성형 엔진) 인용 최적화 어시스턴트입니다.
상품 "${productName}"의 생성 콘텐츠를 모의 AI 검색엔진(${probe.engineId})에서 테스트했습니다. 같은 질문·같은 경쟁 문서 세트에 원본 PDP와 생성 콘텐츠를 각각 넣고, AI 답변에서 얼마나 인용되는지(점유율)를 비교한 결과입니다.

## 질문별 결과 (원본 → 생성)
${queryLines}${overallAttributionLine}

## 안전 점검
${safetyLines || "- (실행되지 않음)"}

## 작업
1. "우선 개선 대상" 질문부터, 콘텐츠가 그 질문의 직접적인 답이 되도록 문장 단위 보강안을 제시하세요. 핵심 결론 선행, 질문-답 구조, 리스트/헤딩 구조화, 근거 범위 내의 구체 수치 스코핑을 우선하세요.
2. 절대 규칙: 아래 콘텐츠에 없는 효능·수치·성분·인증·리뷰를 새로 만들지 마세요.
3. 각 보강안이 어느 질문의 인용률을 높이기 위한 것인지 명시하세요.

## 현재 콘텐츠 섹션
${sectionsText}
`;
  }
  return `You are an AI-search (generative engine) citation optimization assistant.
The generated content for "${productName}" was tested on a simulated AI search engine (${probe.engineId}): with identical questions and competitor documents, the vanilla PDP and the generated content were each measured for citation share in the AI answer.

## Per-question results (vanilla → generated)
${queryLines}${overallAttributionLine}

## Safety check
${safetyLines || "- (not run)"}

## Tasks
1. Starting with the questions marked "fix first", propose sentence-level additions so the content directly answers each question — lead with the conclusion, use question-answer structure, lists/headings, and scope any figures within the existing evidence.
2. Hard rule: never invent benefits, figures, ingredients, certifications, or reviews absent from the content below.
3. State which question each addition targets.

## Current content sections
${sectionsText}
`;
}
