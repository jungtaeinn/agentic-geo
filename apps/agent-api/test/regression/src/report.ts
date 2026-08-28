import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kstTimestamp, loadCaseResults, loadRunMeta } from "./result-store";
import type { CaseResult, CaseStatus, RunMeta } from "./types";

/**
 * run 디렉터리의 케이스 JSON을 병합해 HTML 리포트 한 장을 만든다.
 *
 * 외부 자산을 전혀 참조하지 않는 단일 파일로 만드는 이유: 리포트를 그대로 첨부하거나
 * 다른 사람에게 보내도 깨지지 않아야 하기 때문이다(data-highway의 self-contained 리포트와 같은 방침).
 */
export function generateHtmlReport(directory: string): string | undefined {
  const results = loadCaseResults(directory);
  if (results.length === 0) return undefined;

  const meta = loadRunMeta(directory);
  const path = join(directory, `report_${kstTimestamp()}.html`);
  writeFileSync(path, renderHtml(results, meta), "utf8");
  return path;
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  passed: "PASS",
  warning: "WARN",
  failed: "FAIL",
  error: "ERROR",
  skipped: "SKIP",
};

function renderHtml(results: CaseResult[], meta?: RunMeta): string {
  const counts = countByStatus(results);
  const scored = results.filter((item) => item.evaluation);
  const averages = {
    overall: average(scored.map((item) => item.evaluation?.overallScore ?? 0)),
    geo: average(scored.map((item) => dimensionScore(item, "geo"))),
    cep: average(scored.map((item) => dimensionScore(item, "cep"))),
    eeat: average(scored.map((item) => dimensionScore(item, "eeat"))),
  };

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GEO Regression — ${esc(meta?.runId ?? "")}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="runHeader">
  <div class="runTitle">
    <h1>GEO Regression</h1>
    <span class="runId">${esc(meta?.runId ?? "")}</span>
  </div>
  <dl class="runMeta">
    ${metaRow("실행 모드", meta ? `${meta.mode}${meta.baseUrl ? ` · ${meta.baseUrl}` : ""}` : "-")}
    ${metaRow("환경", meta?.env ?? "-")}
    ${metaRow("provider", meta?.provider ?? "-")}
    ${metaRow("추론 배포", meta?.pipeline.reasoningDeployment ?? "-")}
    ${metaRow("상품 정규화", pipelineFlag(meta?.pipeline.productNormalization))}
    ${metaRow("최종 교정", pipelineFlag(meta?.pipeline.finalProofreading))}
    ${metaRow("LLM 심사", meta?.llmJudge ? "on" : "off")}
    ${metaRow("인용 프로브", meta?.citationProbe ? "on" : "off (v1 미구현)")}
    ${metaRow("케이스 필터", meta?.caseFilter ?? "전체")}
    ${metaRow("시작", meta?.startedAt ?? "-")}
  </dl>
  <p class="pipelineNote">
    파이프라인 설정이 웹 콘솔과 다르면 같은 입력이라도 점수가 달라집니다. 위 항목이 그 차이를 읽는 자리입니다.
  </p>
</header>

<section class="summary">
  <div class="counts">
    ${countCard("passed", counts.passed)}
    ${countCard("warning", counts.warning)}
    ${countCard("failed", counts.failed)}
    ${countCard("error", counts.error)}
    ${countCard("skipped", counts.skipped)}
  </div>
  <div class="averages">
    ${averageCard("총점", averages.overall)}
    ${averageCard("GEO", averages.geo)}
    ${averageCard("CEP", averages.cep)}
    ${averageCard("E-E-A-T", averages.eeat)}
  </div>
</section>

<main>
${results.map(renderCase).join("\n")}
</main>

<script>
document.querySelectorAll(".caseCard > .caseHead").forEach((head) => {
  head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
});
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    await navigator.clipboard.writeText(target.textContent ?? "");
    const original = button.textContent;
    button.textContent = "복사됨";
    setTimeout(() => { button.textContent = original; }, 1400);
  });
});
</script>
</body>
</html>`;
}

function renderCase(result: CaseResult): string {
  const scores = result.evaluation
    ? `<span class="scoreChip">총점 <b>${result.evaluation.overallScore}</b></span>` +
      (["geo", "cep", "eeat"] as const)
        .map((id) => {
          const dimension = result.evaluation?.dimensions.find((item) => item.id === id);
          return dimension
            ? `<span class="scoreChip">${esc(dimension.label)} <b>${dimension.score}</b></span>`
            : "";
        })
        .join("")
    : "";

  const failures = [...result.contractViolations, ...result.minScoreViolations];
  const promptId = `prompt-${sanitizeId(result.id)}`;

  return `<article class="caseCard status-${result.status}">
  <div class="caseHead">
    <span class="statusBadge">${STATUS_LABEL[result.status]}</span>
    <span class="caseId">${esc(result.id)}</span>
    <span class="caseName">${esc(result.name ?? "")}</span>
    <span class="caseScores">${scores}</span>
    <span class="caseDuration">${result.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : ""}</span>
  </div>
  <div class="caseBody">
    ${result.tags.length > 0 ? `<p class="tags">${result.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</p>` : ""}
    ${result.errorMessage ? section("오류", `<pre class="error">${esc(result.errorMessage)}</pre>`) : ""}
    ${failures.length > 0 ? section("기대 불일치", list(failures.map((item) => `<code>${esc(item.rule)}</code> ${esc(item.detail)}`))) : ""}
    ${renderScoreParity(result)}
    ${renderQualityGate(result)}
    ${renderDimensions(result)}
    ${result.easyImprovements.length > 0 ? section("쉬운 개선", list(result.easyImprovements.map(esc))) : ""}
    ${result.validationWarnings.length > 0 ? section(`검증 경고 (${result.validationWarnings.length})`, list(result.validationWarnings.map(esc))) : ""}
    ${renderJudge(result)}
    ${
      result.improvementPrompt
        ? section(
            "수정 프롬프트",
            `<button class="copyButton" data-copy="${promptId}">복사</button><pre id="${promptId}" class="prompt">${esc(result.improvementPrompt)}</pre>`,
          )
        : ""
    }
    ${details("입력 product", `<pre>${esc(JSON.stringify(result.product, null, 2))}</pre>`)}
    ${result.jsonLd ? details("생성 JSON-LD", `<pre>${esc(JSON.stringify(result.jsonLd, null, 2))}</pre>`) : ""}
    ${result.contentSections ? details("생성 콘텐츠 섹션", `<pre>${esc(JSON.stringify(result.contentSections, null, 2))}</pre>`) : ""}
    <p class="footNote">
      ${esc(result.caseFile)}
      ${result.geoGenerationId ? ` · Langfuse sessionId: <code>${esc(result.geoGenerationId)}</code>` : ""}
      ${result.resultHash ? ` · hash: <code>${esc(result.resultHash.slice(0, 12))}</code>` : ""}
    </p>
  </div>
</article>`;
}

function renderDimensions(result: CaseResult): string {
  if (!result.evaluation) return "";
  const blocks = result.evaluation.dimensions
    .map(
      (dimension) => `<div class="dimension">
      <h4>${esc(dimension.label)} <b>${dimension.score}</b>/100</h4>
      <p class="criteria">${esc(dimension.criteria)}</p>
      <p class="summaryText">${esc(dimension.summary)}</p>
      ${dimension.improvements.length > 0 ? `<p class="subhead">개선점</p>${list(dimension.improvements.map(esc))}` : ""}
      ${dimension.evidence.length > 0 ? `<p class="subhead">평가 근거</p>${list(dimension.evidence.map(esc))}` : ""}
    </div>`,
    )
    .join("");
  return section("품질 루브릭", `<div class="dimensions">${blocks}</div>`);
}

function renderQualityGate(result: CaseResult): string {
  const gate = result.qualityGate;
  if (!gate) return "";
  const rows = [
    `활성: ${gate.enabled ? "on" : "off"}`,
    gate.thresholds ? `임계: GEO ${gate.thresholds.geo} / CEP ${gate.thresholds.cep} / E-E-A-T ${gate.thresholds.eeat}` : "",
    gate.initialScores ? `최초 점수: 총점 ${gate.initialScores.overall} (GEO ${gate.initialScores.geo}, CEP ${gate.initialScores.cep}, E-E-A-T ${gate.initialScores.eeat})` : "",
    `교정 시도: ${gate.attempted ? "예" : "아니오"} · 채택: ${gate.adopted ? "예" : "아니오"}`,
    gate.correctedScores ? `교정 점수: 총점 ${gate.correctedScores.overall} (GEO ${gate.correctedScores.geo}, CEP ${gate.correctedScores.cep}, E-E-A-T ${gate.correctedScores.eeat})` : "",
    gate.reason ? `사유: ${gate.reason}` : "",
  ].filter(Boolean);

  return section(
    "생성기 품질 게이트",
    list(rows.map(esc)) +
      (gate.shortfalls.length > 0
        ? `<p class="subhead">게이트가 잡아낸 미달</p>${list(gate.shortfalls.map(esc))}`
        : ""),
  );
}

function renderScoreParity(result: CaseResult): string {
  const parity = result.scoreParity;
  if (!parity) return "";
  return section(
    "점수 일치 검증",
    `<p class="${parity.matched ? "parityOk" : "parityBad"}">${parity.matched ? "일치" : "불일치"} — ${esc(parity.detail)}</p>
     <p class="note">리그레션이 재계산한 루브릭 점수와 생성기가 diagnostics에 기록한 점수를 대조합니다. 불일치는 그 자체로 회귀 신호입니다.</p>`,
  );
}

function renderJudge(result: CaseResult): string {
  if (result.judgeSkippedReason) {
    return section("LLM 심사", `<p class="note">${esc(result.judgeSkippedReason)}</p>`);
  }
  const judge = result.judge;
  if (!judge) return "";
  const promptId = `judge-${sanitizeId(result.id)}`;
  return section(
    "LLM 심사",
    `<p class="judgeVerdict verdict-${judge.verdict}">${judge.verdict.toUpperCase()} · ${judge.score}/10</p>
     <p>${esc(judge.reasoning)}</p>
     ${judge.coveredPoints.length > 0 ? `<p class="subhead">반영된 핵심</p>${list(judge.coveredPoints.map(esc))}` : ""}
     ${judge.missingPoints.length > 0 ? `<p class="subhead">누락·왜곡</p>${list(judge.missingPoints.map(esc))}` : ""}
     ${details("심사 프롬프트", `<button class="copyButton" data-copy="${promptId}">복사</button><pre id="${promptId}">${esc(judge.prompt)}</pre>`)}`,
  );
}

function section(title: string, body: string): string {
  return `<section class="block"><h3>${esc(title)}</h3>${body}</section>`;
}

function details(title: string, body: string): string {
  return `<details class="block"><summary>${esc(title)}</summary>${body}</details>`;
}

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function metaRow(label: string, value: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

function pipelineFlag(value: boolean | undefined): string {
  if (value === undefined) return "-";
  return value ? "on" : "off";
}

function countCard(status: CaseStatus, count: number): string {
  return `<div class="countCard count-${status}"><b>${count}</b><span>${STATUS_LABEL[status]}</span></div>`;
}

function averageCard(label: string, value: number | undefined): string {
  return `<div class="avgCard"><span>${esc(label)}</span><b>${value === undefined ? "-" : value.toFixed(1)}</b></div>`;
}

function countByStatus(results: CaseResult[]): Record<CaseStatus, number> {
  const counts: Record<CaseStatus, number> = { passed: 0, warning: 0, failed: 0, error: 0, skipped: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

function dimensionScore(result: CaseResult, id: "geo" | "cep" | "eeat"): number {
  return result.evaluation?.dimensions.find((item) => item.id === id)?.score ?? 0;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLES = `
:root {
  --bg: #f6f7f9; --fg: #1b1f24; --muted: #6b7280; --line: #e2e5ea; --card: #ffffff;
  --pass: #17803d; --warn: #b45309; --fail: #b91c1c; --error: #7c2d12; --skip: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14171c; --fg: #e8eaed; --muted: #9aa2ae; --line: #2b3038; --card: #1c2027;
          --pass: #4ade80; --warn: #fbbf24; --fail: #f87171; --error: #fb923c; --skip: #9aa2ae; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
       font: 14px/1.6 -apple-system, "Segoe UI", "Noto Sans KR", sans-serif; }
h1 { font-size: 20px; margin: 0; }
h3 { font-size: 13px; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
h4 { font-size: 14px; margin: 0 0 4px; }
ul { margin: 4px 0; padding-left: 18px; }
li { margin: 2px 0; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px;
      overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 420px; }
code { font-size: 12px; background: var(--bg); padding: 1px 4px; border-radius: 3px; }
.runHeader, .summary { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
                       padding: 16px 20px; margin-bottom: 16px; }
.runTitle { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.runId { color: var(--muted); font-size: 13px; }
.runMeta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 20px; margin: 0; }
.runMeta div { display: flex; gap: 8px; }
.runMeta dt { color: var(--muted); min-width: 84px; }
.runMeta dd { margin: 0; font-weight: 600; word-break: break-all; }
.pipelineNote { color: var(--muted); font-size: 12px; margin: 12px 0 0; }
.summary { display: flex; flex-wrap: wrap; gap: 24px; align-items: center; }
.counts, .averages { display: flex; gap: 10px; flex-wrap: wrap; }
.countCard, .avgCard { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px;
                       display: flex; flex-direction: column; align-items: center; min-width: 72px; }
.countCard b, .avgCard b { font-size: 20px; }
.countCard span, .avgCard span { font-size: 11px; color: var(--muted); }
.count-passed b { color: var(--pass); } .count-warning b { color: var(--warn); }
.count-failed b { color: var(--fail); } .count-error b { color: var(--error); }
.caseCard { background: var(--card); border: 1px solid var(--line); border-left-width: 4px;
            border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
.caseCard.status-passed { border-left-color: var(--pass); }
.caseCard.status-warning { border-left-color: var(--warn); }
.caseCard.status-failed { border-left-color: var(--fail); }
.caseCard.status-error { border-left-color: var(--error); }
.caseCard.status-skipped { border-left-color: var(--skip); }
.caseHead { display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; }
.caseHead:hover { background: var(--bg); }
.statusBadge { font-size: 11px; font-weight: 700; letter-spacing: .06em; min-width: 46px; }
.status-passed .statusBadge { color: var(--pass); } .status-warning .statusBadge { color: var(--warn); }
.status-failed .statusBadge { color: var(--fail); } .status-error .statusBadge { color: var(--error); }
.status-skipped .statusBadge { color: var(--skip); }
.caseId { font-weight: 700; } .caseName { color: var(--muted); flex: 1; }
.caseDuration { color: var(--muted); font-size: 12px; }
.scoreChip { font-size: 12px; color: var(--muted); margin-left: 8px; }
.scoreChip b { color: var(--fg); }
.caseBody { display: none; padding: 4px 16px 16px; border-top: 1px solid var(--line); }
.caseCard.open .caseBody { display: block; }
.block { margin: 14px 0; }
.block > summary { cursor: pointer; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.dimensions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.dimension { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.criteria, .summaryText, .note, .footNote { color: var(--muted); font-size: 12px; margin: 2px 0; }
.subhead { font-size: 12px; font-weight: 700; margin: 8px 0 2px; }
.tags { margin: 8px 0; } .tag { font-size: 11px; border: 1px solid var(--line); border-radius: 999px;
        padding: 2px 8px; margin-right: 4px; color: var(--muted); }
.error { color: var(--fail); }
.parityOk { color: var(--pass); font-weight: 600; } .parityBad { color: var(--fail); font-weight: 600; }
.judgeVerdict { font-weight: 700; }
.verdict-pass { color: var(--pass); } .verdict-warning { color: var(--warn); } .verdict-fail { color: var(--fail); }
.copyButton { float: right; font-size: 11px; padding: 3px 10px; border: 1px solid var(--line);
              border-radius: 5px; background: var(--card); color: var(--fg); cursor: pointer; }
.footNote { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--line); }
`;
