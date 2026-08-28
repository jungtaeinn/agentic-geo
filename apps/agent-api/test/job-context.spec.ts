import { currentJobContext, runInJobContext } from "../src/observability/job-context";

describe("job context (MDC)", () => {
  it("exposes no context outside a job", () => {
    expect(currentJobContext()).toBeUndefined();
  });

  it("exposes the context to code called synchronously inside the job", () => {
    let seen: unknown;
    runInJobContext({ geoGenerationId: "abc", attempt: 1 }, () => {
      seen = currentJobContext();
    });
    expect(seen).toEqual({ geoGenerationId: "abc", attempt: 1 });
  });

  it("keeps the context across await boundaries", async () => {
    const seen: unknown[] = [];
    await runInJobContext({ geoGenerationId: "abc", attempt: 1 }, async () => {
      seen.push(currentJobContext());
      await new Promise((resolve) => setTimeout(resolve, 5));
      // 재개 후에도 같은 컨텍스트여야 한다 — 이게 MDC의 핵심이다.
      seen.push(currentJobContext());
    });
    expect(seen).toEqual([
      { geoGenerationId: "abc", attempt: 1 },
      { geoGenerationId: "abc", attempt: 1 },
    ]);
  });

  it("does not leak the context after the job finishes", async () => {
    await runInJobContext({ geoGenerationId: "abc", attempt: 1 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(currentJobContext()).toBeUndefined();
  });

  it("isolates concurrent jobs from each other", async () => {
    const seen: Array<string | undefined> = [];
    const run = (id: string, delayMs: number): Promise<void> =>
      runInJobContext({ geoGenerationId: id, attempt: 1 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(currentJobContext()?.geoGenerationId);
      });

    // 늦게 끝나는 작업이 먼저 시작해도 서로의 컨텍스트를 덮어쓰지 않아야 한다.
    await Promise.all([run("slow", 20), run("fast", 1)]);
    expect(seen).toEqual(["fast", "slow"]);
  });
});
