import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CaseExpectations, RegressionCase } from "./types";

const casesDirectory = join(__dirname, "..", "cases");
const caseFileExtensions = [".yaml", ".yml"];

/**
 * `cases/` 아래 one-file-per-case YAML을 로드한다.
 *
 * 로딩 시점에 형식을 엄격히 검증하는 이유: 케이스 파일이 잘못되면 "테스트 실패"가 아니라
 * "측정 자체가 성립하지 않음"이므로, 잘못된 케이스가 조용히 통과하는 것보다 즉시 터지는 편이 낫다.
 */
export function loadRegressionCases(filter?: string): RegressionCase[] {
  const files = readdirSync(casesDirectory)
    .filter((name) => caseFileExtensions.some((extension) => name.endsWith(extension)))
    .sort();

  const cases = files.map((name) => parseCaseFile(join(casesDirectory, name)));
  assertUniqueIds(cases);

  const selected = resolveFilter(filter);
  if (!selected) return cases;

  const known = new Set(cases.map((item) => item.id));
  const unknown = [...selected].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `CASES에 존재하지 않는 케이스 ID가 있습니다: ${unknown.join(", ")}\n` +
        `사용 가능한 ID: ${[...known].join(", ")}`,
    );
  }
  return cases.filter((item) => selected.has(item.id));
}

/** `CASES=GEO-001,GEO-004` 형태의 쉼표 구분 필터를 집합으로 바꾼다. */
function resolveFilter(filter?: string): Set<string> | undefined {
  const raw = (filter ?? process.env.CASES ?? "").trim();
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}

function assertUniqueIds(cases: RegressionCase[]): void {
  const seen = new Map<string, string>();
  for (const item of cases) {
    const previous = seen.get(item.id);
    if (previous) {
      throw new Error(`케이스 ID가 중복됩니다: ${item.id} (${previous}, ${item.caseFile})`);
    }
    seen.set(item.id, item.caseFile);
  }
}

function parseCaseFile(path: string): RegressionCase {
  let payload: unknown;
  try {
    payload = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`케이스 YAML 파싱 실패: ${path}\n${(error as Error).message}`);
  }

  if (!isRecord(payload)) {
    throw new Error(`케이스 파일은 객체여야 합니다: ${path}`);
  }

  const id = requireString(payload.id, "id", path);
  const request = payload.request;
  if (!isRecord(request)) {
    throw new Error(`request가 없거나 객체가 아닙니다: ${path}`);
  }

  const locale = requireString(request.locale, "request.locale", path);
  if (!isRecord(request.product)) {
    throw new Error(`request.product가 없거나 객체가 아닙니다: ${path}`);
  }

  return {
    id,
    name: optionalString(payload.name),
    tags: normalizeTags(payload.tags, path),
    skip: payload.skip === true,
    timeoutMs: optionalNumber(payload.timeoutMs, "timeoutMs", path),
    request: { locale, product: request.product },
    expect: normalizeExpectations(payload.expect, path),
    caseFile: path,
  };
}

function normalizeTags(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) {
    throw new Error(`tags는 문자열 또는 문자열 배열이어야 합니다: ${path}`);
  }
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeExpectations(raw: unknown, path: string): CaseExpectations {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new Error(`expect는 객체여야 합니다: ${path}`);
  }

  const resultStatus = optionalString(raw.resultStatus);
  if (resultStatus && resultStatus !== "SUCCEEDED" && resultStatus !== "SUCCEEDED_WITH_WARNINGS") {
    throw new Error(
      `expect.resultStatus는 SUCCEEDED 또는 SUCCEEDED_WITH_WARNINGS여야 합니다: ${path} (받은 값: ${resultStatus})`,
    );
  }

  return {
    resultStatus: resultStatus as CaseExpectations["resultStatus"],
    schemaTypes: optionalStringArray(raw.schemaTypes, "expect.schemaTypes", path),
    forbiddenSchemaTypes: optionalStringArray(raw.forbiddenSchemaTypes, "expect.forbiddenSchemaTypes", path),
    maxValidationWarnings: optionalNumber(raw.maxValidationWarnings, "expect.maxValidationWarnings", path),
    contains: optionalStringArray(raw.contains, "expect.contains", path),
    notContains: optionalStringArray(raw.notContains, "expect.notContains", path),
    jsonPath: normalizeJsonPathExpectations(raw.jsonPath, path),
    minScore: normalizeMinScore(raw.minScore, path),
    goldenAnswer: optionalString(raw.goldenAnswer),
  };
}

function normalizeJsonPathExpectations(raw: unknown, path: string): CaseExpectations["jsonPath"] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`expect.jsonPath는 배열이어야 합니다: ${path}`);
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`expect.jsonPath[${index}]는 객체여야 합니다: ${path}`);
    }
    const expressionPath = requireString(item.path, `expect.jsonPath[${index}].path`, path);
    if (item.equals === undefined && item.contains === undefined && item.exists === undefined) {
      throw new Error(
        `expect.jsonPath[${index}]에 equals/contains/exists 중 하나는 있어야 합니다: ${path}`,
      );
    }
    return {
      path: expressionPath,
      equals: item.equals,
      contains: optionalString(item.contains),
      exists: typeof item.exists === "boolean" ? item.exists : undefined,
    };
  });
}

function normalizeMinScore(raw: unknown, path: string): CaseExpectations["minScore"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`expect.minScore는 객체여야 합니다: ${path}`);
  }
  const allowed = ["overall", "geo", "cep", "eeat"] as const;
  const unknownKeys = Object.keys(raw).filter((key) => !allowed.includes(key as (typeof allowed)[number]));
  if (unknownKeys.length > 0) {
    throw new Error(
      `expect.minScore에 알 수 없는 항목이 있습니다: ${unknownKeys.join(", ")} (${path}). ` +
        `허용: ${allowed.join(", ")}`,
    );
  }
  const result: NonNullable<CaseExpectations["minScore"]> = {};
  for (const key of allowed) {
    const value = optionalNumber(raw[key], `expect.minScore.${key}`, path);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, path: string): string {
  const text = optionalString(value);
  if (!text) {
    throw new Error(`${field}가 비어 있거나 문자열이 아닙니다: ${path}`);
  }
  return text;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalStringArray(value: unknown, field: string, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field}는 배열이어야 합니다: ${path}`);
  }
  return value.map((item) => String(item));
}

function optionalNumber(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field}는 숫자여야 합니다: ${path}`);
  }
  return value;
}
