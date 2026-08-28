import { GeoQueue } from "../src/geo/geo-queue.service";
import type { GeoJobData } from "../src/geo/geo-job.types";
import { currentJobContext } from "../src/observability/job-context";

function job(id: string): GeoJobData {
  return { geoGenerationId: id, locale: "ko-KR", product: {} };
}

function makeQueue(
  overrides: Partial<{ concurrency: number; maxAttempts: number; backoffMs: number }> = {},
): GeoQueue {
  return new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 1, ...overrides });
}

/** 대기 중인 마이크로태스크와 짧은 타이머가 소진될 때까지 양보한다. */
async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("GeoQueue", () => {
  it("runs at most `concurrency` jobs at the same time", async () => {
    const queue = makeQueue({ concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    queue.setHandler(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
    });

    for (let i = 0; i < 5; i += 1) queue.add(job(`id-${i}`));
    await flush();
    expect(peak).toBe(2);

    while (release.length > 0) {
      release.shift()!();
      await flush();
    }
    expect(peak).toBe(2);
  });

  it("excludes running jobs from the waiting count", async () => {
    const queue = makeQueue({ concurrency: 1 });
    let release: () => void = () => {};
    queue.setHandler(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    queue.add(job("a"));
    queue.add(job("b"));
    await flush();
    expect(queue.getWaitingCount()).toBe(1);
    release();
    await flush();
  });

  it("drains jobs added before the handler was wired", async () => {
    const queue = makeQueue({ concurrency: 1 });
    queue.add(job("early"));
    expect(queue.getWaitingCount()).toBe(1);

    const seen: string[] = [];
    queue.setHandler(async (j) => {
      seen.push(j.data.geoGenerationId);
    });
    await flush();
    expect(seen).toEqual(["early"]);
  });

  it("ignores a duplicate geoGenerationId while one is already tracked", async () => {
    const queue = makeQueue({ concurrency: 1 });
    const seen: string[] = [];
    queue.setHandler(async (j) => {
      seen.push(j.data.geoGenerationId);
    });
    queue.add(job("dup"));
    queue.add(job("dup"));
    await flush();
    expect(seen).toEqual(["dup"]);
  });

  it("keeps deduping while a job waits for its retry backoff", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 50 });
    const attempts: number[] = [];
    queue.setHandler(async (j) => {
      attempts.push(j.attemptsMade);
      throw new Error("boom");
    });
    queue.add(job("retry-dup"));
    await flush();
    queue.add(job("retry-dup"));
    await flush(120);
    expect(attempts).toEqual([0, 1]);
  });

  it("passes 0-based attemptsMade to the handler", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 1 });
    const seen: number[] = [];
    queue.setHandler(async (j) => {
      seen.push(j.attemptsMade);
      throw new Error("boom");
    });
    queue.add(job("attempts"));
    await flush(60);
    expect(seen).toEqual([0, 1]);
  });

  it("stops after maxAttempts and does not retry further", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 1 });
    let calls = 0;
    queue.setHandler(async () => {
      calls += 1;
      throw new Error("always fails");
    });
    queue.add(job("exhaust"));
    await flush(60);
    expect(calls).toBe(2);
  });

  it("releases the job when a retry succeeds", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 1 });
    let calls = 0;
    queue.setHandler(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    });
    queue.add(job("recovers"));
    await flush(60);
    expect(calls).toBe(2);

    queue.add(job("recovers"));
    await flush();
    expect(calls).toBe(3);
  });

  it("does not leak handler rejections as unhandled rejections", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 1, backoffMs: 1 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    queue.setHandler(async () => {
      throw new Error("boom");
    });
    queue.add(job("isolated"));
    await flush(50);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("discards waiting jobs and cancels retry timers on shutdown", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 50 });
    const started: string[] = [];
    let release: () => void = () => {};
    queue.setHandler(async (j) => {
      started.push(j.data.geoGenerationId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    queue.add(job("running"));
    queue.add(job("queued"));
    await flush();
    expect(started).toEqual(["running"]);
    expect(queue.getWaitingCount()).toBe(1);

    queue.onApplicationShutdown();
    expect(queue.getWaitingCount()).toBe(0);

    release();
    await flush(120);
    expect(started).toEqual(["running"]);
  });

  it("cancels a pending retry timer on shutdown and does not invoke the handler again", async () => {
    const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 200 });
    let calls = 0;
    queue.setHandler(async () => {
      calls += 1;
      throw new Error("boom");
    });
    queue.add(job("shutdown-during-backoff"));
    await flush();
    expect(calls).toBe(1);

    // 백오프 타이머가 대기 중인 상태에서 종료
    queue.onApplicationShutdown();

    // 원래의 backoffMs(200ms)가 지나도 재시도가 실행되지 않아야 한다
    await flush(250);
    expect(calls).toBe(1);
  });

  describe("constructor validation", () => {
    it("constructs successfully with valid options", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 5000 })).not.toThrow();
    });

    it("throws when concurrency is 0 (e.g. derived from an empty-string env var)", () => {
      expect(() => new GeoQueue({ concurrency: 0, maxAttempts: 2, backoffMs: 5000 })).toThrow();
    });

    it("throws when concurrency is NaN (e.g. derived from a garbage env var)", () => {
      expect(() => new GeoQueue({ concurrency: NaN, maxAttempts: 2, backoffMs: 5000 })).toThrow();
    });

    it("throws when concurrency is negative", () => {
      expect(() => new GeoQueue({ concurrency: -1, maxAttempts: 2, backoffMs: 5000 })).toThrow();
    });

    it("throws when concurrency is not an integer", () => {
      expect(() => new GeoQueue({ concurrency: 1.5, maxAttempts: 2, backoffMs: 5000 })).toThrow();
    });

    it("throws when maxAttempts is 0", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 0, backoffMs: 5000 })).toThrow();
    });

    it("throws when maxAttempts is NaN", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: NaN, backoffMs: 5000 })).toThrow();
    });

    it("throws when maxAttempts is negative", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: -2, backoffMs: 5000 })).toThrow();
    });

    it("throws when maxAttempts is not an integer", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 2.5, backoffMs: 5000 })).toThrow();
    });

    it("throws when backoffMs is NaN", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: NaN })).toThrow();
    });

    it("throws when backoffMs is negative", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: -1 })).toThrow();
    });

    it("does not throw when backoffMs is 0", () => {
      expect(() => new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 0 })).not.toThrow();
    });
  });

  describe("observability", () => {
    it("reports how many jobs are running", async () => {
      const queue = makeQueue({ concurrency: 2 });
      expect(queue.activeCount).toBe(0);

      const release: Array<() => void> = [];
      queue.setHandler(async () => {
        await new Promise<void>((resolve) => release.push(resolve));
      });
      queue.add(job("a"));
      queue.add(job("b"));
      queue.add(job("c"));
      await flush();
      // concurrency=2 → 2건 실행, 1건 대기
      expect(queue.activeCount).toBe(2);
      expect(queue.getWaitingCount()).toBe(1);

      release.shift()!();
      await flush();
      expect(queue.activeCount).toBe(2);
      expect(queue.getWaitingCount()).toBe(0);

      while (release.length > 0) {
        release.shift()!();
        await flush();
      }
      expect(queue.activeCount).toBe(0);
    });

    it("runs the handler inside a job context carrying the id and attempt", async () => {
      const queue = makeQueue({ concurrency: 1, maxAttempts: 2, backoffMs: 1 });
      const seen: Array<{ geoGenerationId: string; attempt: number } | undefined> = [];
      queue.setHandler(async () => {
        seen.push(currentJobContext());
        // await 이후에도 컨텍스트가 유지되어야 로그가 전 구간에서 상관관계를 갖는다.
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(currentJobContext());
        throw new Error("boom");
      });
      queue.add(job("ctx-job"));
      await flush(60);

      // 1회차(attempt 1) 2줄 + 재시도(attempt 2) 2줄
      expect(seen).toEqual([
        { geoGenerationId: "ctx-job", attempt: 1 },
        { geoGenerationId: "ctx-job", attempt: 1 },
        { geoGenerationId: "ctx-job", attempt: 2 },
        { geoGenerationId: "ctx-job", attempt: 2 },
      ]);
    });
  });
});
