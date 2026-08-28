import type { EvalUiLanguage } from "../types";
import type { CitationProbeResult } from "../citation/probe";
import type { GeoQualityEvaluation } from "./evaluate";

/**
 * Evaluation-suite presentation logic shared by UIs: bilingual suite copy,
 * the marketing-friendly "what to change" summary, probe display helpers,
 * and safety-note derivation. Pure functions — rendering stays in the app.
 */

export function getEvaluationSuiteCopy(language: EvalUiLanguage) {
  if (language === "ko") {
    return {
      kicker: "후속 평가",
      title: "품질 진단 + 인용 테스트",
      note: "생성된 산출물을 두 단계로 점검합니다. ① 구조·근거 품질 진단(항상 실행), ② 모의 AI 검색엔진 인용 테스트(설정에서 프로브를 켠 경우). 인용률 예측이 아닌 보수적 진단입니다.",
      qualityBlockTitle: "① 품질 진단 · GEO / CEP / E-E-A-T",
      probeBlockTitle: "② 인용 테스트 · Citation Probe",
      easyTitle: "무엇을 바꾸면 좋아지나요",
      easyCitationItem: (query: string) => `[인용] "${query}" 질문에 직접 답하는 문장을 콘텐츠에 추가하세요.`,
      easyValidationIntro: (count: number) => `자동 점검이 지목한 문구 ${count}건 — 각 항목을 아래 표시된 위치에서 고쳐주세요:`,
      easyKpcItem: (count: number) => `[필수] 상품 근거와 어긋나는 문장 ${count}건을 먼저 수정하세요. 게시 전 반드시 확인이 필요합니다.`,
      citationTileSub: (vanilla: number, generated: number) => `원본 ${vanilla}% → 생성 ${generated}%`,
      citationTileEnableHint: "설정에서 프로브를 켜면 측정됩니다",
      citationTileError: "실행되지 않았어요",
      citationDetailLabel: "인용 테스트 상세",
      probeDetailHeading: "인용 테스트",
      easyHeadline: (label: string, friendly: string, score: number) =>
        `${label}(${friendly}) 영역이 ${score}점으로 가장 낮아요. 아래 항목부터 반영하면 효과가 가장 큽니다.`,
      easyAllGood: "세 영역 모두 양호해요. 아래 항목을 반영하면 더 안정적입니다.",
      easyEmpty: "지금 바로 고쳐야 할 항목이 없습니다.",
      dimFriendly: {
        geo: "AI가 읽는 구조",
        cep: "고객 질문·상황 표현",
        eeat: "신뢰 근거 표현"
      } as Record<string, string>,
      qualityPromptButton: "LLM 개선 프롬프트 복사",
      probePromptButton: "LLM 인용 개선 프롬프트 복사",
      promptCopiedLabel: "복사됨",
      promptHint: "복사한 프롬프트를 Claude Code 같은 LLM에 붙여넣으면, 이 진단을 근거로 한 수정안을 받아 재생성 → 재평가하는 개선 사이클을 돌릴 수 있습니다.",
      probeOffHint: "설정 → 입력 설정에서 인용 프로브를 켜면, 이 콘텐츠가 AI 답변에서 원본 PDP보다 얼마나 더 인용되는지 함께 측정합니다.",
      probeErrorTitle: "인용 테스트가 실행되지 않았어요",
      probeHeadlineUp: (vanilla: number, generated: number, delta: number) =>
        `원본 PDP만 있을 때 AI 답변은 우리 상품 정보를 ${vanilla}%만 인용했지만, 생성 콘텐츠로 바꾸자 ${generated}%를 인용했어요 (+${delta}%p).`,
      probeHeadlineFlat: (vanilla: number, generated: number) =>
        `원본 PDP와 생성 콘텐츠가 AI 답변에서 비슷한 비중으로 인용됐어요 (${vanilla}% → ${generated}%).`,
      probeHeadlineDown: (vanilla: number, generated: number, delta: number) =>
        `생성 콘텐츠(${generated}%)가 원본 PDP(${vanilla}%)보다 AI 답변에서 덜 인용됐어요 (${delta}%p). 아래 프롬프트로 보완하거나 원본 유지를 검토하세요.`,
      probeShareExplainer: "인용 비중은 AI가 우리 문서 1개와 경쟁 문서 4개를 함께 참고해 답변을 쓸 때, 답변 문장들이 우리 문서를 출처로 인용한 비율이에요. 높을수록 AI 답변에 우리 상품 정보가 더 많이 쓰였다는 뜻입니다.",
      citationRowLabel: "AI 답변 인용 비중",
      narrativeMethod: (count: number, breakdown: string, engine: string) =>
        `고객이 물어볼 법한 질문 ${count}개(${breakdown})를 만들어, 우리 문서 1개와 경쟁 문서 4개를 나란히 준 모의 AI 검색엔진(${engine})에게 질문마다 답변을 쓰게 했어요. 같은 조건에서 문서만 원본 PDP ↔ 생성 콘텐츠로 바꿔 두 번씩 테스트했습니다.`,
      narrativeWhyUp: (query: string, sectionLabel: string, sharePct: number) =>
        `가장 크게 오른 질문은 "${query}"였어요. 이 답변에서 인용의 ${sharePct}%를 ${sectionLabel} 섹션이 벌었는데, 질문에 직접 답하는 문장이 그 섹션에 있었기 때문이에요.`,
      narrativeWhyUpNoAttribution: (query: string) =>
        `가장 크게 오른 질문은 "${query}"였어요. 생성 콘텐츠에 이 질문에 직접 답하는 문장이 있었기 때문이에요.`,
      narrativeWhyDown: "생성 콘텐츠가 질문에 직접 답하지 못한 경우가 많았어요. 아래 'LLM 인용 개선 프롬프트'로 부족한 질문부터 보강하는 것을 권합니다.",
      narrativeWhyFlat: "두 버전 모두 질문에 비슷한 수준으로 답해서 인용 차이가 나지 않았어요.",
      attributionLabel: "인용 기여",
      overallAttributionLabel: "전체 인용 기여 (어느 섹션이 인용을 벌었나)",
      sectionLabels: {
        productName: "상품명",
        description: "설명",
        productDescription: "상품 설명 (Product)",
        webPageDescription: "페이지 설명 (WebPage)",
        quickFacts: "핵심 정보",
        benefits: "효능",
        ingredients: "성분",
        howToUse: "사용법",
        faq: "FAQ",
        other: "기타(미매칭)"
      } as Record<string, string>,
      moreSentences: (count: number) => ` 외 ${count}문장`,
      probeSubline: (count: number, engine: string) =>
        `같은 질문 ${count}개와 같은 경쟁 문서를 두고, 원본 PDP와 생성 콘텐츠를 각각 넣어 모의 AI 검색엔진(${engine})의 답변 인용을 비교한 결과입니다.`,
      vanillaLabel: "원본 PDP",
      generatedLabel: "생성 콘텐츠",
      safetyPassTitle: "안전 점검 통과",
      safetyFailTitle: "안전 점검 주의",
      safetyPassNote: "인용이 줄지 않았고, 상품 근거와 어긋나는 문장도 발견되지 않았어요.",
      safetyDeltaFail: "생성 콘텐츠가 원본보다 덜 인용됐어요.",
      safetyKpcFail: (count: number) =>
        `생성 문장 중 상품 근거와 어긋나는 내용이 ${count}건 발견됐어요. 게시 전 반드시 해당 문장을 확인하세요.`,
      safetyKprInfo: (supported: number, total: number) =>
        `상품 근거 ${total}개 중 ${supported}개가 콘텐츠에 반영됐어요. 요약 콘텐츠 특성상 일부 생략은 정상입니다.`,
      detailSummary: "상세 내용",
      outcomeLabels: {
        improved: "크게 개선",
        flat: "비슷함",
        worse: "원본이 우세"
      } as Record<string, string>,
      queryShare: (vanilla: number, generated: number) => `원본일 때 ${vanilla}% → 생성 후 ${generated}% 인용`,
      querySourceLabels: {
        "content-plan-faq": "콘텐츠 플랜 FAQ",
        "content-plan-cep": "콘텐츠 플랜 CEP",
        template: "카테고리 템플릿"
      } as Record<string, string>,
      warningsLabel: "경고",
      interpretation: "모의 엔진 기준, 이 상품 하나에 대한 1회성 비교입니다. 다른 상품·다른 실행과 비교하거나 실제 인용 확률로 해석하지 마세요."
    };
  }
  return {
    kicker: "Follow-up evaluation",
    title: "Quality diagnosis + citation test",
    note: "The output is checked in two stages: (1) structure/evidence quality diagnosis (always on), (2) a simulated-engine citation test (when the probe is enabled in settings). Conservative diagnostics, not citation-rate predictions.",
    qualityBlockTitle: "1. Quality diagnosis · GEO / CEP / E-E-A-T",
    probeBlockTitle: "2. Citation test · Citation Probe",
    easyTitle: "What to change",
    easyCitationItem: (query: string) => `[Citation] Add sentences that directly answer "${query}".`,
    easyValidationIntro: (count: number) => `Copy flagged by automated checks (${count}) — fix each item where indicated below:`,
    easyKpcItem: (count: number) => `[Critical] Fix ${count} sentence(s) that contradict the product evidence before publishing.`,
    citationTileSub: (vanilla: number, generated: number) => `vanilla ${vanilla}% → generated ${generated}%`,
    citationTileEnableHint: "Enable the probe in settings to measure",
    citationTileError: "Did not run",
    citationDetailLabel: "Citation test detail",
    probeDetailHeading: "Citation test",
    easyHeadline: (label: string, friendly: string, score: number) =>
      `${label} (${friendly}) scored lowest at ${score}. Applying the items below yields the biggest gains.`,
    easyAllGood: "All three areas look healthy. The items below make them even sturdier.",
    easyEmpty: "Nothing needs an immediate fix.",
    dimFriendly: {
      geo: "structure AI reads",
      cep: "customer questions & context",
      eeat: "trust & evidence wording"
    } as Record<string, string>,
    qualityPromptButton: "Copy LLM improvement prompt",
    probePromptButton: "Copy LLM citation prompt",
    promptCopiedLabel: "Copied",
    promptHint: "Paste the copied prompt into an LLM such as Claude Code to get diagnosis-grounded fixes, then regenerate and re-evaluate — a quality improvement loop.",
    probeOffHint: "Enable the citation probe in Settings → Input to also measure how much more this content gets cited in AI answers than the vanilla PDP.",
    probeErrorTitle: "Citation test did not run",
    probeHeadlineUp: (vanilla: number, generated: number, delta: number) =>
      `With only the vanilla PDP, the AI answer cited our product content just ${vanilla}% of the time — after switching to the generated content it cited us ${generated}% (+${delta}%p).`,
    probeHeadlineFlat: (vanilla: number, generated: number) =>
      `The vanilla PDP and the generated content were cited about equally in the AI answer (${vanilla}% → ${generated}%).`,
    probeHeadlineDown: (vanilla: number, generated: number, delta: number) =>
      `The generated content (${generated}%) was cited less than the vanilla PDP (${vanilla}%) in the AI answer (${delta}%p). Consider the prompt below or keeping the original.`,
    probeShareExplainer: "Citation share is how much of the AI answer cites our document when the AI writes from our document plus 4 competitor documents. Higher means more of the answer came from our product content.",
    citationRowLabel: "AI-answer citation share",
    narrativeMethod: (count: number, breakdown: string, engine: string) =>
      `We built ${count} question(s) customers would actually ask (${breakdown}) and had a simulated AI search engine (${engine}) answer each one from our document plus 4 competitor documents. Under identical conditions, only the document was swapped: vanilla PDP vs generated content.`,
    narrativeWhyUp: (query: string, sectionLabel: string, sharePct: number) =>
      `The biggest gain came on "${query}". The ${sectionLabel} section earned ${sharePct}% of the citations in that answer, because it contained sentences that directly answer the question.`,
    narrativeWhyUpNoAttribution: (query: string) =>
      `The biggest gain came on "${query}", because the generated content contains sentences that directly answer it.`,
    narrativeWhyDown: "The generated content often failed to answer the questions directly. Use the citation-improvement prompt below, starting with the weakest questions.",
    narrativeWhyFlat: "Both versions answered the questions about equally well, so citations did not shift.",
    attributionLabel: "Citation contribution",
    overallAttributionLabel: "Overall contribution (which section earned the citations)",
    sectionLabels: {
      productName: "Product name",
      description: "Description",
      productDescription: "Product description",
      webPageDescription: "WebPage description",
      quickFacts: "Quick facts",
      benefits: "Benefits",
      ingredients: "Ingredients",
      howToUse: "How to use",
      faq: "FAQ",
      other: "other (unmatched)"
    } as Record<string, string>,
    moreSentences: (count: number) => ` +${count} more`,
    probeSubline: (count: number, engine: string) =>
      `Result of testing the vanilla PDP and the generated content against the same ${count} question(s) and identical competitor documents on a simulated AI search engine (${engine}).`,
    vanillaLabel: "Vanilla PDP",
    generatedLabel: "Generated content",
    safetyPassTitle: "Safety check passed",
    safetyFailTitle: "Safety check — attention",
    safetyPassNote: "Citations did not drop and no sentence contradicts the product evidence.",
    safetyDeltaFail: "The generated content was cited less than the original.",
    safetyKpcFail: (count: number) =>
      `${count} generated sentence(s) contradict the product evidence. Review them before publishing.`,
    safetyKprInfo: (supported: number, total: number) =>
      `${supported} of ${total} evidence items are reflected in the content. Some omission is normal for summary copy.`,
    detailSummary: "Details",
    outcomeLabels: {
      improved: "Much improved",
      flat: "About the same",
      worse: "Original wins"
    } as Record<string, string>,
    queryShare: (vanilla: number, generated: number) => `cited ${vanilla}% with vanilla → ${generated}% with generated`,
    querySourceLabels: {
      "content-plan-faq": "content-plan FAQ",
      "content-plan-cep": "content-plan CEP",
      template: "category template"
    } as Record<string, string>,
    warningsLabel: "Warnings",
    interpretation: "One-shot comparison for this product on a simulated engine. Never compare across products or runs, and never read it as a production citation probability."
  };
}

export type EvaluationSuiteCopy = ReturnType<typeof getEvaluationSuiteCopy>;

export function shareToPct(value: number): number {
  return Math.round(value * 100);
}

export function formatPctDelta(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct > 0 ? "+" : ""}${pct}%p`;
}

export function probeQueryOutcome(deltaWordpos: number): "improved" | "flat" | "worse" {
  if (deltaWordpos > 0.05) {
    return "improved";
  }
  if (deltaWordpos < -0.05) {
    return "worse";
  }
  return "flat";
}

export interface EasyImprovementItem {
  text: string;
  subItems?: string[];
}

export function buildEasyImprovementSummary(
  evaluation: GeoQualityEvaluation,
  suite: EvaluationSuiteCopy,
  validationPointerPrefix: string
): { headline: string; items: EasyImprovementItem[] } {
  const sorted = [...evaluation.dimensions].sort((a, b) => a.score - b.score);
  const lowest = sorted[0];
  const items: EasyImprovementItem[] = [];
  for (const dimension of sorted) {
    for (const improvement of dimension.improvements) {
      if (items.length >= 3) {
        break;
      }
      // The generic "N pieces of copy were flagged" line is a pointer, not an
      // action. In the easy summary we expand it into the actual flagged copy
      // so marketing users see WHICH sentences to fix without digging.
      if (validationPointerPrefix && improvement.startsWith(validationPointerPrefix)) {
        if (!items.some((item) => item.subItems) && evaluation.validationDetails.length > 0) {
          items.push({
            text: `[${dimension.label}] ${suite.easyValidationIntro(evaluation.validationDetails.length)}`,
            subItems: evaluation.validationDetails.slice(0, 3)
          });
        }
        continue;
      }
      const line = `[${dimension.label}] ${improvement}`;
      if (!items.some((item) => item.text === line)) {
        items.push({ text: line });
      }
    }
  }
  const headline = lowest && lowest.score < 90
    ? suite.easyHeadline(lowest.label, suite.dimFriendly[lowest.id] ?? "", lowest.score)
    : suite.easyAllGood;
  return { headline, items };
}

export function buildProbeSafetyNotes(probe: CitationProbeResult, suite: EvaluationSuiteCopy): string[] {
  const notes: string[] = [];
  if (probe.mean.delta.wordpos < 0) {
    notes.push(suite.safetyDeltaFail);
  }
  const coverage = probe.keypointCoverage;
  if (coverage) {
    if (coverage.contradicted > 0) {
      notes.push(suite.safetyKpcFail(coverage.contradicted));
    }
    notes.push(suite.safetyKprInfo(coverage.supported, coverage.total));
  }
  if (probe.gate.pass) {
    notes.unshift(suite.safetyPassNote);
  }
  return notes;
}

export function formatQuerySourceBreakdown(
  probe: CitationProbeResult,
  suite: EvaluationSuiteCopy
): string {
  const counts = new Map<string, number>();
  for (const query of probe.queries) {
    counts.set(query.querySource, (counts.get(query.querySource) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => `${suite.querySourceLabels[source] ?? source} ${count}`)
    .join(" · ");
}

export function buildProbeNarrativeWhy(
  probe: CitationProbeResult,
  suite: EvaluationSuiteCopy,
  deltaPct: number
): string {
  if (deltaPct < 0) {
    return suite.narrativeWhyDown;
  }
  if (deltaPct === 0) {
    return suite.narrativeWhyFlat;
  }
  const bestQuery = [...probe.queries].sort((a, b) => b.delta.wordpos - a.delta.wordpos)[0];
  if (!bestQuery) {
    return suite.narrativeWhyFlat;
  }
  const topSection = bestQuery.sectionAttribution?.find((item) => item.sectionId !== "other");
  if (topSection && topSection.share >= 0.2) {
    return suite.narrativeWhyUp(
      bestQuery.query,
      suite.sectionLabels[topSection.sectionId] ?? topSection.sectionId,
      shareToPct(topSection.share)
    );
  }
  return suite.narrativeWhyUpNoAttribution(bestQuery.query);
}

export function truncateQuote(value: string, max = 110): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function formatSectionAttribution(
  attribution: NonNullable<CitationProbeResult["sectionAttribution"]>,
  suite: EvaluationSuiteCopy
): string {
  return attribution
    .filter((item) => item.share >= 0.05)
    .slice(0, 3)
    .map((item) => `${suite.sectionLabels[item.sectionId] ?? item.sectionId} ${shareToPct(item.share)}%`)
    .join(" · ");
}
