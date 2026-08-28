import { PassThrough } from "node:stream";
import pino from "pino";
import { buildPinoOptions } from "../src/observability/logger-options";
import { runInJobContext } from "../src/observability/job-context";

/**
 * 프로덕션과 "동일한 옵션"으로 실제 pino를 조립해 출력 JSON을 검증한다.
 * 프로덕션 코드에 테스트용 주입 지점을 만들지 않기 위해 destination만 테스트가 직접 넘긴다.
 */
type Line = Record<string, unknown>;

function capture(): { logger: pino.Logger; lines: () => Line[]; at: (i: number) => Line } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString()));
  const logger = pino(buildPinoOptions(), stream);
  const lines = (): Line[] =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Line);

  const at = (i: number): Line => {
    const line = lines()[i];
    if (line === undefined) throw new Error(`로그 ${i}번째 줄이 없습니다 (총 ${lines().length}줄)`);
    return line;
  };

  return { logger, lines, at };
}

describe("pino options", () => {
  it("writes the level as a name, not a number", () => {
    const { logger, at } = capture();
    logger.info({ event: "x" });
    expect(at(0).level).toBe("info");
  });

  it("maps each level to its standard name", () => {
    const { logger, lines } = capture();
    logger.info({ event: "i" });
    logger.warn({ event: "w" });
    logger.error({ event: "e" });
    logger.fatal({ event: "f" });
    expect(lines().map((l) => l.level)).toEqual(["info", "warn", "error", "fatal"]);
  });

  it("drops levels below the default threshold", () => {
    const { logger, lines } = capture();
    logger.debug({ event: "d" });
    logger.trace({ event: "t" });
    logger.info({ event: "i" });
    // 기본 임계값은 info — debug/trace는 나가지 않아야 한다.
    expect(lines().map((l) => l.event)).toEqual(["i"]);
  });

  it("honours LOG_LEVEL for the threshold", () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const { logger, lines } = capture();
      logger.debug({ event: "d" });
      logger.trace({ event: "t" });
      expect(lines().map((l) => l.event)).toEqual(["d"]);
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  it("writes the timestamp as an ISO-8601 string", () => {
    const { logger, at } = capture();
    logger.info({ event: "x" });
    expect(String(at(0).time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("lifts caller-supplied fields to top-level keys", () => {
    const { logger, at } = capture();
    logger.info({ event: "job.completed", geoGenerationId: "abc", durationMs: 4231 });
    expect(at(0)).toMatchObject({
      event: "job.completed",
      geoGenerationId: "abc",
      durationMs: 4231,
    });
  });

  it("merges the job context into every line logged inside a job", async () => {
    const { logger, lines } = capture();
    await runInJobContext({ geoGenerationId: "in-job", attempt: 2 }, async () => {
      logger.info({ event: "job.started" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.info({ event: "job.completed" });
    });
    expect(lines()).toHaveLength(2);
    for (const line of lines()) {
      expect(line).toMatchObject({ geoGenerationId: "in-job", attempt: 2 });
    }
  });

  it("adds no job fields to lines logged outside a job", () => {
    const { logger, at } = capture();
    logger.info({ event: "boot" });
    expect(at(0)).not.toHaveProperty("geoGenerationId");
  });

  it("does not let a caller field overwrite level or time", () => {
    const { logger, at } = capture();
    logger.info({ event: "x", level: "fatal", time: "1999-01-01T00:00:00.000Z" });
    const line = at(0);
    expect(line.level).toBe("info");
    expect(line.time).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("serializes an Error into message and stack fields", () => {
    const { logger, at } = capture();
    logger.error({ event: "job.failed", err: new Error("boom") });
    const err = at(0).err as Record<string, unknown>;
    expect(err.message).toBe("boom");
    expect(String(err.stack)).toContain("boom");
  });
});

describe("pino options — secrets and request shape", () => {
  it("never writes the x-api-key header, even when the whole request is bound", () => {
    const { logger, at } = capture();
    logger.info({
      event: "http.request",
      req: {
        id: "req-1",
        method: "POST",
        url: "/internal/v1/geo/generations",
        headers: { "x-api-key": "super-secret", "content-type": "application/json" },
      },
    });
    expect(JSON.stringify(at(0))).not.toContain("super-secret");
  });

  it("reduces a bound request to id, method and url", () => {
    const { logger, at } = capture();
    logger.info({
      event: "job.started",
      req: {
        id: "req-1",
        method: "POST",
        url: "/internal/v1/geo/generations",
        headers: { "user-agent": "curl/8.6.0" },
        remoteAddress: "::1",
        remotePort: 1234,
      },
    });
    expect(at(0).req).toEqual({ id: "req-1", method: "POST", url: "/internal/v1/geo/generations" });
  });

  it("reduces a bound response to its status code", () => {
    const { logger, at } = capture();
    logger.info({
      event: "http.request",
      res: { statusCode: 202, headers: { etag: 'W/"abc"' } },
    });
    expect(at(0).res).toEqual({ statusCode: 202 });
  });

  it("redacts authorization and cookie headers too", () => {
    const { logger, at } = capture();
    logger.info({
      event: "http.request",
      req: { id: "r", method: "GET", url: "/", headers: { authorization: "Bearer tok", cookie: "s=1" } },
    });
    const dumped = JSON.stringify(at(0));
    expect(dumped).not.toContain("Bearer tok");
    expect(dumped).not.toContain("s=1");
  });
});
