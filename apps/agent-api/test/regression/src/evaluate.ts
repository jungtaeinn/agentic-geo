import {
  buildEasyImprovementSummary,
  evaluateGeoQuality,
  formatGeoQualityEvaluationText,
  formatQualityLlmPrompt,
  getEvaluationSuiteCopy,
  getGeoQualityCopy,
  type GeoQualityEvaluation,
} from "@agentic-geo/pdp-geo-eval-agent";
import type { EvalDiagnosticsInput } from "@agentic-geo/pdp-geo-eval-agent/types";
import type { GenerationOutcome } from "./runner";
import type {
  CaseExpectations,
  ContractViolation,
  QualityGateSnapshot,
  RegressionCase,
} from "./types";

const evaluationLanguage = "ko" as const;

/**
 * 2층 — 결정적 품질 루브릭.
 *
 * 웹 콘솔(`GeoGeneratorConsole`)이 화면에 그리는 GEO/CEP/E-E-A-T 점수와 **같은 함수**다.
 * 생성기의 quality gate도 내부에서 이 루브릭을 쓰므로, 여기서 재계산한 값은 생성기가
 * diagnostics에 기록한 점수와 일치해야 한다(대조는 `compareScoreParity` 참고).
 */
export function evaluateOutcome(outcome: GenerationOutcome): {
  evaluation: GeoQualityEvaluation;
  report: string;
  improvementPrompt?: string;
  easyImprovements: string[];
} {
  const diagnostics = toEvalDiagnostics(outcome.diagnostics);
  const evaluation = evaluateGeoQuality({ jsonLd: outcome.jsonLd, diagnostics }, evaluationLanguage);

  const productName =
    outcome.contentSections?.productName ?? diagnostics.normalizedProduct.name ?? "";
  const report = formatGeoQualityEvaluationText(productName, evaluation, evaluationLanguage);

  const improvementPrompt = outcome.contentSections
    ? formatQualityLlmPrompt(
        { productName, contentSections: outcome.contentSections, jsonLd: outcome.jsonLd },
        evaluation,
        evaluationLanguage,
      )
    : undefined;

  return {
    evaluation,
    report,
    improvementPrompt,
    easyImprovements: buildEasyImprovements(evaluation),
  };
}

/** 콘솔의 "쉬운 개선" 요약과 같은 목록을 텍스트 줄로 평탄화한다. */
function buildEasyImprovements(evaluation: GeoQualityEvaluation): string[] {
  const copy = getGeoQualityCopy(evaluationLanguage);
  const suite = getEvaluationSuiteCopy(evaluationLanguage);
  // 콘솔과 동일한 방식으로 "검증 경고 N건" 포인터 문구의 접두사를 얻는다.
  const validationPointerPrefix = copy.validationImprovement(987654).split("987654")[0] ?? "";
  const summary = buildEasyImprovementSummary(evaluation, suite, validationPointerPrefix);
  return summary.items.flatMap((item) => [item.text, ...(item.subItems ?? []).map((sub) => `  · ${sub}`)]);
}

/** 생성기 diagnostics를 평가 에이전트의 구조적 입력 계약으로 좁힌다. */
function toEvalDiagnostics(raw: Record<string, unknown>): EvalDiagnosticsInput {
  const record = raw as Partial<EvalDiagnosticsInput>;
  return {
    normalizedProduct: record.normalizedProduct ?? {},
    validationWarnings: record.validationWarnings ?? [],
    validationRepairs: record.validationRepairs,
    ragUsage: record.ragUsage,
    evidence: record.evidence,
    evidenceLedger: record.evidenceLedger,
    contentPlan: record.contentPlan,
  };
}

/** 생성기가 자기 산출물에 매긴 quality gate 진단을 꺼낸다. */
export function readQualityGate(diagnostics: Record<string, unknown>): QualityGateSnapshot | undefined {
  const gate = diagnostics.qualityGate as Record<string, unknown> | undefined;
  if (!gate) return undefined;
  return {
    enabled: gate.enabled === true,
    thresholds: gate.thresholds as QualityGateSnapshot["thresholds"],
    initialScores: gate.initialScores as QualityGateSnapshot["initialScores"],
    correctedScores: gate.correctedScores as QualityGateSnapshot["correctedScores"],
    shortfalls: (gate.shortfalls as string[] | undefined) ?? [],
    attempted: gate.attempted === true,
    adopted: gate.adopted === true,
    reason: gate.reason as string | undefined,
  };
}

/**
 * 재계산 점수와 생성기 기록 점수를 대조한다.
 *
 * 생성기는 교정본이 "측정상 개선됐을 때만" 채택하므로, 최종 아티팩트의 점수는
 * 채택 여부에 따라 `correctedScores` 또는 `initialScores`와 같아야 한다. 어긋난다면
 * 루브릭이 바뀌었거나 생성기가 게이트 이후 아티팩트를 손댔다는 뜻이라, 그 자체가 회귀 신호다.
 */
export function compareScoreParity(
  evaluation: GeoQualityEvaluation,
  gate: QualityGateSnapshot | undefined,
): { matched: boolean; comparedAgainst: "initialScores" | "correctedScores"; detail: string } | undefined {
  if (!gate?.enabled) return undefined;
  const comparedAgainst = gate.adopted && gate.correctedScores ? "correctedScores" : "initialScores";
  const recorded = comparedAgainst === "correctedScores" ? gate.correctedScores : gate.initialScores;
  if (!recorded) return undefined;

  const actual = toScoreMap(evaluation);
  const mismatches = (["overall", "geo", "cep", "eeat"] as const)
    .filter((key) => actual[key] !== recorded[key])
    .map((key) => `${key}: 재계산 ${actual[key]} vs 기록 ${recorded[key]}`);

  return {
    matched: mismatches.length === 0,
    comparedAgainst,
    detail:
      mismatches.length === 0
        ? `${comparedAgainst}와 일치 (overall ${actual.overall})`
        : mismatches.join(", "),
  };
}

function toScoreMap(evaluation: GeoQualityEvaluation): Record<"overall" | "geo" | "cep" | "eeat", number> {
  const byId = new Map(evaluation.dimensions.map((dimension) => [dimension.id, dimension.score]));
  return {
    overall: evaluation.overallScore,
    geo: byId.get("geo") ?? 0,
    cep: byId.get("cep") ?? 0,
    eeat: byId.get("eeat") ?? 0,
  };
}

/**
 * 1층 — 결정적 계약 검증. LLM을 쓰지 않고 케이스의 `expect`를 그대로 대조한다.
 * 여기서 걸리는 건 전부 확정적 실패다(점수 하한은 별도로 분리해 둔다 — 성격이 다르다).
 */
export function checkContract(testCase: RegressionCase, outcome: GenerationOutcome): ContractViolation[] {
  const expectations = testCase.expect;
  const violations: ContractViolation[] = [];

  if (expectations.resultStatus && outcome.resultStatus !== expectations.resultStatus) {
    violations.push({
      rule: "resultStatus",
      detail: `기대 ${expectations.resultStatus}, 실제 ${outcome.resultStatus}`,
    });
  }

  const actualTypes = new Set(outcome.schemaTypes);
  for (const type of expectations.schemaTypes ?? []) {
    if (!actualTypes.has(type)) {
      violations.push({
        rule: "schemaTypes",
        detail: `${type} 노드가 없습니다 (실제: ${outcome.schemaTypes.join(", ") || "없음"})`,
      });
    }
  }
  for (const type of expectations.forbiddenSchemaTypes ?? []) {
    if (actualTypes.has(type)) {
      violations.push({ rule: "forbiddenSchemaTypes", detail: `${type} 노드가 발행되었습니다` });
    }
  }

  if (
    expectations.maxValidationWarnings !== undefined &&
    outcome.validationWarnings.length > expectations.maxValidationWarnings
  ) {
    violations.push({
      rule: "maxValidationWarnings",
      detail:
        `허용 ${expectations.maxValidationWarnings}건, 실제 ${outcome.validationWarnings.length}건` +
        ` — ${outcome.validationWarnings.slice(0, 3).join(" / ")}`,
    });
  }

  const publicText = collectTextValues(outcome.jsonLd).join("\n");
  for (const needle of expectations.contains ?? []) {
    if (!publicText.includes(needle)) {
      violations.push({ rule: "contains", detail: `공개 텍스트에 "${needle}"가 없습니다` });
    }
  }
  for (const needle of expectations.notContains ?? []) {
    if (publicText.includes(needle)) {
      violations.push({ rule: "notContains", detail: `공개 텍스트에 "${needle}"가 있습니다` });
    }
  }

  for (const expectation of expectations.jsonPath ?? []) {
    violations.push(...checkJsonPath(outcome.jsonLd, expectation));
  }

  return violations;
}

/** 점수 하한(2층) 위반. 계약 위반과 분리해 리포트에서 원인을 구분해 보여준다. */
export function checkMinScore(
  expectations: CaseExpectations,
  evaluation: GeoQualityEvaluation,
): ContractViolation[] {
  if (!expectations.minScore) return [];
  const actual = toScoreMap(evaluation);
  return (Object.entries(expectations.minScore) as Array<[keyof typeof actual, number]>)
    .filter(([key, floor]) => actual[key] < floor)
    .map(([key, floor]) => ({
      rule: `minScore.${key}`,
      detail: `하한 ${floor}, 실제 ${actual[key]}`,
    }));
}

function checkJsonPath(
  jsonLd: unknown,
  expectation: NonNullable<CaseExpectations["jsonPath"]>[number],
): ContractViolation[] {
  const found = resolveJsonPath(jsonLd, expectation.path);
  const rule = `jsonPath(${expectation.path})`;

  if (expectation.exists !== undefined) {
    const exists = found.length > 0;
    if (exists !== expectation.exists) {
      return [{ rule, detail: expectation.exists ? "경로가 없습니다" : "경로가 존재합니다" }];
    }
  }

  if (expectation.equals !== undefined) {
    const matched = found.some((value) => JSON.stringify(value) === JSON.stringify(expectation.equals));
    if (!matched) {
      return [
        {
          rule,
          detail: `기대 ${JSON.stringify(expectation.equals)}, 실제 ${
            found.length > 0 ? JSON.stringify(found.slice(0, 3)) : "값 없음"
          }`,
        },
      ];
    }
  }

  if (expectation.contains !== undefined) {
    const needle = expectation.contains;
    const matched = found.some((value) => typeof value === "string" && value.includes(needle));
    if (!matched) {
      return [{ rule, detail: `"${needle}"를 포함하는 값이 없습니다` }];
    }
  }

  return [];
}

/**
 * 점 표기 경로 해석기. `@graph[].name` 처럼 `[]`로 배열 전체를 순회하고,
 * `@graph[0].name` 처럼 인덱스도 받는다. 매칭된 값을 모두 돌려준다.
 *
 * jsonpath 라이브러리를 끌어오지 않는 이유: 케이스가 필요로 하는 건 "그래프 안 어떤 노드의
 * 어떤 필드" 수준이고, 의존성 하나를 더 얹을 만큼의 표현력이 필요하지 않다.
 */
export function resolveJsonPath(root: unknown, path: string): unknown[] {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[\]/g, ".[]")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  let current: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if (segment === "[]") {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      if (Array.isArray(value)) {
        const index = Number(segment);
        if (Number.isInteger(index)) {
          if (index >= 0 && index < value.length) next.push(value[index]);
          continue;
        }
        // 인덱스가 아니면 배열 원소 각각에서 같은 키를 찾는다 — 그래프 순회를 짧게 쓰기 위해서다.
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            const child = (item as Record<string, unknown>)[segment];
            if (child !== undefined) next.push(child);
          }
        }
        continue;
      }
      if (typeof value === "object") {
        const child = (value as Record<string, unknown>)[segment];
        if (child !== undefined) next.push(child);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/** JSON-LD 안의 모든 문자열 값을 모은다(공개 텍스트 검증용). */
function collectTextValues(value: unknown, depth = 0): string[] {
  if (depth > 12) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTextValues(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectTextValues(item, depth + 1),
    );
  }
  return [];
}
