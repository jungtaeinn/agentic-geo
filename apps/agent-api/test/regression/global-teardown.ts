import { openReport, resolveOpenPolicy, shouldOpen } from "./src/open-report";
import { generateHtmlReport } from "./src/report";
import { loadCaseResults, runDirectory } from "./src/result-store";

/** 실행이 끝나면 run 디렉터리의 케이스 JSON을 병합해 HTML 리포트 한 장을 만들고, 필요하면 띄운다. */
export default async function globalTeardown(): Promise<void> {
  try {
    const directory = runDirectory();
    const path = generateHtmlReport(directory);
    if (!path) {
      console.log("\n[geo-regression] 저장된 케이스 결과가 없어 리포트를 만들지 않았습니다.");
      return;
    }

    console.log(`\n[geo-regression] HTML 리포트: ${path}`);

    const policy = resolveOpenPolicy();
    if (shouldOpen(policy, loadCaseResults(directory)) && openReport(path)) {
      console.log(`[geo-regression] 리포트를 열었습니다 (GEO_REGRESSION_OPEN=${policy}).`);
      return;
    }
    console.log(`[geo-regression] 열기: open "${path}"`);
  } catch (error) {
    // 리포트 생성·열기 실패가 테스트 결과를 뒤집지 않게 한다 — 케이스 JSON은 이미 디스크에 남아 있다.
    console.error(`\n[geo-regression] 리포트 처리 실패: ${(error as Error).message}`);
  }
}
