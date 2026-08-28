import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult, RunMeta } from "./types";

const resultsRoot = join(__dirname, "..", "results");
const RUN_ID_ENV = "GEO_REGRESSION_RUN_ID";
const META_FILE = "_run.json";

/**
 * 실행별 산출물 디렉터리를 관리한다.
 *
 * run id를 환경변수로 승격시키는 이유: jest 리포터는 테스트 파일과 다른 모듈 인스턴스에서 돌기 때문에
 * 모듈 스코프 변수로는 같은 run 디렉터리를 가리킬 수 없다. 프로세스 환경이 둘 사이의 유일한 공유 채널이다.
 */
export function resolveRunId(): string {
  const existing = process.env[RUN_ID_ENV];
  if (existing) return existing;
  const runId = `run_${kstTimestamp()}`;
  process.env[RUN_ID_ENV] = runId;
  return runId;
}

export function runDirectory(): string {
  const directory = join(resultsRoot, resolveRunId());
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** 케이스 결과 하나를 JSON으로 남긴다. 예외가 나도 반드시 호출되어야 한다. */
export function saveCaseResult(result: CaseResult): string {
  const path = join(runDirectory(), `${sanitize(result.id)}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
  return path;
}

export function saveRunMeta(meta: RunMeta): void {
  writeFileSync(join(runDirectory(), META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

export function loadRunMeta(directory: string): RunMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(directory, META_FILE), "utf8")) as RunMeta;
  } catch {
    return undefined;
  }
}

/** run 디렉터리의 케이스 결과를 id 순으로 모은다. 메타 파일은 제외한다. */
export function loadCaseResults(directory: string): CaseResult[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }
  return files
    .filter((name) => name.endsWith(".json") && name !== META_FILE)
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf8")) as CaseResult;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is CaseResult => item !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** KST 기준 `YYYYMMDDHHmmss`. 디렉터리 이름이 실행 시각으로 정렬되도록 한다. */
export function kstTimestamp(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
