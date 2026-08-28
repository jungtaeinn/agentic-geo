import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { kstTimestamp } from "./src/result-store";

/**
 * 실행 식별자를 **부모 프로세스에서** 확정한다.
 *
 * jest 워커는 부모의 process.env를 상속하지만 반대 방향으로는 전파되지 않는다. run id를 워커에서
 * 만들면 워커마다 다른 디렉터리가 생기고 teardown은 그중 아무것도 못 찾는다. 그래서 여기서 한 번 정한다.
 */
export default async function globalSetup(): Promise<void> {
  loadEnv({ path: join(__dirname, "..", "..", ".env") });
  process.env.GEO_REGRESSION_RUN_ID ??= `run_${kstTimestamp()}`;
}
