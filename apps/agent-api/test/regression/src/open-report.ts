import { spawn } from "node:child_process";
import type { CaseResult } from "./types";

/**
 * 실행이 끝나면 HTML 리포트를 브라우저로 띄운다.
 *
 * 기본값을 "대화형 터미널일 때만"으로 둔 이유: 리포트는 사람이 보라고 만드는 것이라 손으로 돌릴 때는
 * 바로 열리는 편이 낫지만, CI·스크립트·파이프 실행에서 브라우저를 띄우면 프로세스가 붙잡히거나
 * 헤드리스 환경에서 에러가 난다. TTY 여부가 그 둘을 가르는 가장 단순한 신호다.
 */
export type OpenPolicy = "always" | "on-failure" | "never";

const ENV_KEY = "GEO_REGRESSION_OPEN";

export function resolveOpenPolicy(env: NodeJS.ProcessEnv = process.env): OpenPolicy {
  const raw = (env[ENV_KEY] ?? "").trim().toLowerCase();
  // 하위호환·직관성: true/false 도 받는다.
  if (raw === "always" || raw === "true" || raw === "1") return "always";
  if (raw === "never" || raw === "false" || raw === "0") return "never";
  if (raw === "on-failure") return "on-failure";
  if (raw) {
    throw new Error(`${ENV_KEY}는 always | on-failure | never 여야 합니다 (받은 값: ${raw})`);
  }
  // 미지정 기본값 — CI에서는 열지 않는다.
  if (env.CI) return "never";
  return process.stdout.isTTY ? "always" : "never";
}

export function shouldOpen(policy: OpenPolicy, results: CaseResult[]): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return results.some((item) => item.status === "failed" || item.status === "error");
}

/** 플랫폼별 열기 명령. 없는 플랫폼이면 undefined 를 돌려 호출부가 조용히 건너뛰게 한다. */
export function resolveOpenCommand(platform: NodeJS.Platform = process.platform):
  | { command: string; args: string[] }
  | undefined {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  if (platform === "linux") return { command: "xdg-open", args: [] };
  return undefined;
}

/**
 * 리포트를 연다. 실패해도 예외를 밖으로 내보내지 않는다 — 리포트를 못 띄운 것이
 * 테스트 결과를 뒤집어서는 안 된다(파일은 이미 디스크에 있다).
 */
export function openReport(path: string): boolean {
  const resolved = resolveOpenCommand();
  if (!resolved) return false;
  try {
    // detached + unref: 뷰어 프로세스가 jest 종료를 붙잡지 않게 한다.
    const child = spawn(resolved.command, [...resolved.args, path], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
