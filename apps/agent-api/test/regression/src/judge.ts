import { completeWithProvider, type GeoEvalEngineConfig } from "@agentic-geo/pdp-geo-eval-agent";
import type { GenerationOutcome } from "./runner";
import type { JudgeResult, RegressionCase } from "./types";

/**
 * 3층 — LLM-as-Judge.
 *
 * data-highway-agent `tests/stage_regression/.../evaluator.py`의 판정 체계를 그대로 옮겼다:
 * 1~10점을 매기고 7 이상 pass, 4~6 warning, 3 이하 fail. 모범답변(`expect.goldenAnswer`)은
 * **선택 입력**이며 사실 검증용 참고 자료로만 쓴다 — 표현이 다르다는 이유로 감점하지 않는다.
 *
 * 결정적 루브릭(2층)이 못 잡는 것을 본다: 스키마 위생은 멀쩡한데 카피가 입력 사실과 어긋나거나,
 * 근거 없는 효능이 들어갔거나, 질문 의도와 동떨어진 FAQ가 붙은 경우.
 */

const SCORE_PASS_THRESHOLD = 7;
const SCORE_WARNING_THRESHOLD = 4;

export function isJudgeEnabled(): boolean {
  return /^true$/i.test(process.env.GEO_REGRESSION_LLM_JUDGE ?? "");
}

/**
 * 심사용 엔진 설정을 환경에서 만든다. 생성기와 같은 provider 규칙을 재사용하되,
 * `GEO_REGRESSION_JUDGE_*`로 심사 전용 모델을 따로 지정할 수 있다.
 * 자격증명이 없으면 예외 대신 undefined를 돌려준다 — 심사는 opt-in이고, 설정 미비로
 * 케이스 전체가 죽는 것보다 "심사 생략" 사유를 결과에 남기는 편이 낫다.
 */
export function resolveJudgeEngine(): { engine?: GeoEvalEngineConfig; reason?: string } {
  const provider = (process.env.GEO_REGRESSION_JUDGE_PROVIDER ?? process.env.AGENTIC_GEO_PROVIDER ?? "mock")
    .trim()
    .toLowerCase();

  if (provider === "mock") {
    return { reason: "LLM 심사 생략: provider가 mock입니다." };
  }

  const temperature = Number(process.env.GEO_REGRESSION_JUDGE_TEMPERATURE ?? 0);

  switch (provider) {
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      const model = process.env.GEO_REGRESSION_JUDGE_MODEL ?? process.env.OPENAI_MODEL;
      if (!apiKey || !model) return { reason: "LLM 심사 생략: OPENAI_API_KEY 또는 모델이 없습니다." };
      return { engine: { provider: "openai", apiKey, model, temperature } };
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      const model = process.env.GEO_REGRESSION_JUDGE_MODEL ?? process.env.GEMINI_MODEL;
      if (!apiKey || !model) return { reason: "LLM 심사 생략: GEMINI_API_KEY 또는 모델이 없습니다." };
      return { engine: { provider: "gemini", apiKey, model, temperature } };
    }
    case "azure-openai": {
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const deployment =
        process.env.GEO_REGRESSION_JUDGE_DEPLOYMENT ??
        process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ??
        process.env.AZURE_OPENAI_DEPLOYMENT;
      if (!apiKey || !endpoint || !deployment) {
        return { reason: "LLM 심사 생략: AZURE_OPENAI 키/엔드포인트/배포명이 부족합니다." };
      }
      return {
        engine: {
          provider: "azure-openai",
          apiKey,
          endpoint,
          deployment,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION,
          temperature,
        },
      };
    }
    case "aistudio": {
      const apiKey = process.env.AISTUDIO_API_KEY;
      const endpoint = process.env.AISTUDIO_ENDPOINT;
      const deployment = process.env.GEO_REGRESSION_JUDGE_DEPLOYMENT ?? process.env.AISTUDIO_MODEL;
      if (!apiKey || !endpoint || !deployment) {
        return { reason: "LLM 심사 생략: AISTUDIO 키/엔드포인트/모델이 부족합니다." };
      }
      return {
        engine: {
          provider: "aistudio",
          apiKey,
          endpoint,
          deployment,
          apiVersion: process.env.AISTUDIO_API_VERSION,
          temperature,
        },
      };
    }
    default:
      return { reason: `LLM 심사 생략: 지원하지 않는 provider(${provider})입니다.` };
  }
}

export async function judgeOutcome(
  testCase: RegressionCase,
  outcome: GenerationOutcome,
  engine: GeoEvalEngineConfig,
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(testCase, outcome);
  const raw = await completeWithProvider(engine, JUDGE_SYSTEM_PROMPT, prompt);
  const parsed = extractJsonObject(raw);

  const score = clampScore(parsed.score);
  return {
    score,
    verdict: scoreToVerdict(score),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    coveredPoints: toStringArray(parsed.coveredPoints ?? parsed.covered_points),
    missingPoints: toStringArray(parsed.missingPoints ?? parsed.missing_points),
    prompt,
  };
}

const JUDGE_SYSTEM_PROMPT = [
  "당신은 PDP GEO 산출물 품질 평가기입니다.",
  "요청한 JSON 객체 하나만 반환하고, 그 밖의 설명은 붙이지 마세요.",
].join("\n");

function buildJudgePrompt(testCase: RegressionCase, outcome: GenerationOutcome): string {
  const goldenSection = testCase.expect.goldenAnswer
    ? [
        "",
        "## 참고 모범답변",
        "",
        "```text",
        testCase.expect.goldenAnswer,
        "```",
      ].join("\n")
    : "";

  const goldenPrinciple = testCase.expect.goldenAnswer
    ? "5. 참고 모범답변은 사실 검증용입니다. 표현·구조가 다르다는 이유로 감점하지 말고, 사실이 모순되거나 핵심이 빠졌을 때만 감점하세요."
    : "5. 모범답변이 없으므로 입력 product의 사실 범위만을 기준으로 판단하세요.";

  return [
    "# PDP GEO 산출물 평가",
    "",
    "## 판정 원칙",
    "",
    "1. 입력 product가 담은 사실이 산출 스키마·콘텐츠에 충분히 반영됐는지 먼저 봅니다.",
    "2. 표현이나 문장 순서가 달라도 의미가 같으면 반영된 것으로 봅니다.",
    "3. 입력에 없는 효능·수치·성분·인증·리뷰가 새로 만들어졌다면 강하게 감점합니다.",
    "4. 정보가 추가로 더 있다는 이유만으로는 감점하지 않습니다.",
    goldenPrinciple,
    "",
    "## 입력 product (agent-api 요청 본문)",
    "",
    "```json",
    JSON.stringify(testCase.request.product, null, 2),
    "```",
    "",
    "## 생성된 콘텐츠 섹션",
    "",
    "```json",
    JSON.stringify(outcome.contentSections ?? {}, null, 2),
    "```",
    "",
    "## 생성된 JSON-LD",
    "",
    "```json",
    JSON.stringify(outcome.jsonLd, null, 2),
    "```",
    goldenSection,
    "",
    "## 출력 형식",
    "",
    "```json",
    "{",
    '  "score": 1~10 정수,',
    '  "reasoning": "판정 근거 요약",',
    '  "coveredPoints": ["산출물이 제대로 담아낸 핵심"],',
    '  "missingPoints": ["누락됐거나 왜곡된 핵심"]',
    "}",
    "```",
  ].join("\n");
}

function scoreToVerdict(score: number): JudgeResult["verdict"] {
  if (score >= SCORE_PASS_THRESHOLD) return "pass";
  if (score >= SCORE_WARNING_THRESHOLD) return "warning";
  return "fail";
}

function clampScore(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`심사 응답의 score를 해석할 수 없습니다: ${JSON.stringify(value)}`);
  }
  return Math.min(10, Math.max(1, Math.round(numeric)));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** LLM 응답에서 JSON 객체를 뽑는다. 코드펜스로 감싸는 모델이 흔해 두 경로를 모두 본다. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const candidate = fenced?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0];
  if (!candidate) {
    throw new Error(`심사 응답에서 JSON 객체를 찾지 못했습니다: ${text.slice(0, 200)}`);
  }
  return JSON.parse(candidate) as Record<string, unknown>;
}
