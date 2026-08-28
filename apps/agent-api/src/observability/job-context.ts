import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 백그라운드 작업 1건의 로그 상관관계 컨텍스트 (GEO-222).
 *
 * nestjs-pino의 컨텍스트는 HTTP 요청 수명에 묶여 있는데, GEO 생성 작업은 202 응답 이후에
 * 비동기로 돌기 때문에 요청 스코프를 벗어난다. 그래서 작업 전용 컨텍스트를 따로 둔다.
 * Java의 MDC/ThreadContext와 같은 역할이다.
 */
export interface JobContext {
  geoGenerationId: string;
  /** 1-based. 사람이 읽는 로그용이므로 GeoQueueJob.attemptsMade + 1이다. */
  attempt: number;
}

const storage = new AsyncLocalStorage<JobContext>();

/** fn 실행 중(await 재개 이후를 포함해) currentJobContext()가 context를 반환하게 한다. */
export function runInJobContext<T>(context: JobContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentJobContext(): JobContext | undefined {
  return storage.getStore();
}
