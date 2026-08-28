import { loadRegressionCases } from "./src/case-loader";
import {
  checkContract,
  checkMinScore,
  compareScoreParity,
  evaluateOutcome,
  readQualityGate,
} from "./src/evaluate";
import { isJudgeEnabled, judgeOutcome, resolveJudgeEngine } from "./src/judge";
import { buildRunMeta, createRunner } from "./src/runner";
import { resolveRunId, saveCaseResult, saveRunMeta } from "./src/result-store";
import type { CaseResult } from "./src/types";

/**
 * GEO 생성 회귀 — 케이스 YAML 하나가 테스트 하나가 된다.
 *
 * 실행:
 *   pnpm test:regression                                     로컬 모드(서버 불필요)
 *   CASES=GEO-001,GEO-003 pnpm test:regression               케이스 선택
 *   GEO_REGRESSION_MODE=http pnpm test:regression            떠 있는 agent-api 호출
 *   GEO_REGRESSION_LLM_JUDGE=true pnpm test:regression       LLM 심사 켜기
 *
 * 자세한 옵션은 test/regression/README.md 참고.
 */

const cases = loadRegressionCases();
const runner = createRunner();
const runId = resolveRunId();
const runMeta = buildRunMeta(runId, runner);
const judge = isJudgeEnabled() ? resolveJudgeEngine() : { reason: "LLM 심사 비활성(GEO_REGRESSION_LLM_JUDGE)" };

const defaultTimeoutMs = Number(process.env.GEO_REGRESSION_TIMEOUT_MS ?? 600_000);

beforeAll(() => {
  saveRunMeta(runMeta);
});

describe("GEO 생성 회귀", () => {
  if (cases.length === 0) {
    it("실행할 케이스가 없다", () => {
      throw new Error("cases/ 아래에 케이스 YAML이 없습니다.");
    });
    return;
  }

  it.each(cases.map((item) => [item.id, item] as const))(
    "%s",
    async (_id, testCase) => {
      const result: CaseResult = {
        id: testCase.id,
        name: testCase.name,
        tags: testCase.tags,
        caseFile: testCase.caseFile,
        status: "error",
        failureMode: "exception",
        mode: runner.mode,
        baseUrl: runner.baseUrl,
        locale: testCase.request.locale,
        product: testCase.request.product,
        validationWarnings: [],
        easyImprovements: [],
        contractViolations: [],
        minScoreViolations: [],
      };

      if (testCase.skip) {
        result.status = "skipped";
        result.failureMode = "-";
        saveCaseResult(result);
        return;
      }

      const startedAt = Date.now();
      try {
        const outcome = await runner.run(testCase);
        result.durationMs = Date.now() - startedAt;
        result.geoGenerationId = outcome.geoGenerationId;
        result.resultStatus = outcome.resultStatus;
        result.schemaTypes = outcome.schemaTypes;
        result.resultHash = outcome.resultHash;
        result.ragProfile = outcome.ragProfile;
        result.jsonLd = outcome.jsonLd;
        result.contentSections = outcome.contentSections;
        result.validationWarnings = outcome.validationWarnings;

        // 1층 — 결정적 계약 검증
        result.contractViolations = checkContract(testCase, outcome);

        // 2층 — 결정적 품질 루브릭 (기대값이 없어도 항상 기록한다)
        const evaluated = evaluateOutcome(outcome);
        result.evaluation = evaluated.evaluation;
        result.evaluationReport = evaluated.report;
        result.improvementPrompt = evaluated.improvementPrompt;
        result.easyImprovements = evaluated.easyImprovements;
        result.minScoreViolations = checkMinScore(testCase.expect, evaluated.evaluation);

        result.qualityGate = readQualityGate(outcome.diagnostics);
        result.scoreParity = compareScoreParity(evaluated.evaluation, result.qualityGate);

        // 3층 — LLM 심사 (opt-in)
        if (judge.engine) {
          result.judge = await judgeOutcome(testCase, outcome, judge.engine);
        } else {
          result.judgeSkippedReason = judge.reason;
        }

        result.status = resolveStatus(result);
        result.failureMode = resolveFailureMode(result);

        assertCaseOutcome(result);
      } catch (error) {
        result.durationMs ??= Date.now() - startedAt;
        if (result.status === "error") {
          result.errorMessage = error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally {
        // 예외가 나도 결과를 남긴다 — 실패 케이스일수록 산출물이 필요하다.
        saveCaseResult(result);
      }
    },
    defaultTimeoutMs,
  );
});

function resolveStatus(result: CaseResult): CaseResult["status"] {
  if (result.contractViolations.length > 0) return "failed";
  if (result.minScoreViolations.length > 0) return "failed";
  if (result.judge?.verdict === "fail") return "failed";
  if (result.scoreParity && !result.scoreParity.matched) return "warning";
  if (result.judge?.verdict === "warning") return "warning";
  return "passed";
}

function resolveFailureMode(result: CaseResult): string {
  if (result.contractViolations.length > 0) return "contract";
  if (result.minScoreViolations.length > 0) return "min_score";
  if (result.judge?.verdict === "fail") return "judge_fail";
  if (result.scoreParity && !result.scoreParity.matched) return "score_parity";
  if (result.judge?.verdict === "warning") return "judge_warning";
  return "-";
}

/**
 * fail만 테스트 실패로 올린다. warning은 리포트에 남기고 통과시킨다 —
 * 경고까지 빨간불로 만들면 아무도 안 보게 되고, 그러면 진짜 실패도 같이 묻힌다.
 */
function assertCaseOutcome(result: CaseResult): void {
  if (result.status !== "failed") return;

  const lines = [
    `[${result.id}] 회귀 실패 (${result.failureMode})`,
    ...result.contractViolations.map((item) => `  계약: ${item.rule} — ${item.detail}`),
    ...result.minScoreViolations.map((item) => `  점수: ${item.rule} — ${item.detail}`),
  ];
  if (result.judge?.verdict === "fail") {
    lines.push(`  심사: ${result.judge.score}/10 — ${result.judge.reasoning}`);
    for (const missing of result.judge.missingPoints) lines.push(`    누락: ${missing}`);
  }
  throw new Error(lines.join("\n"));
}
