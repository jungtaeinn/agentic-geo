import { stdSerializers, stdTimeFunctions, type LoggerOptions } from "pino";
import { currentJobContext } from "./job-context";

/**
 * 서비스 전체 로그의 JSON 형태를 한 곳에서 정한다 (GEO-222).
 *
 * 고정 필드는 여기서 붙이고(level·time·err), 호출자가 넘긴 객체의 키는 그대로 최상위로 올라간다.
 * 작업 컨텍스트(geoGenerationId·attempt)는 mixin이 매 줄에 자동으로 병합하므로
 * 호출부가 손으로 넘길 필요가 없다.
 */
export function buildPinoOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    // 기본 pino는 level을 숫자(30)로 낸다. 로그 수집기에서 바로 읽히도록 이름으로 낸다.
    formatters: {
      level: (label) => ({ level: label }),
      // 호출자가 level/time을 넘겨도 무시한다. `.info()`로 찍힌 줄의 level이 "fatal"로
      // 나가면 알람이 거짓으로 뜨므로, 이 두 필드는 로거만 정할 수 있어야 한다.
      log: (obj: Record<string, unknown>) => {
        const { level, time, ...rest } = obj;
        void level;
        void time;
        return rest;
      },
    },
    timestamp: stdTimeFunctions.isoTime,
    serializers: {
      // Error를 message/stack으로 펼친다.
      err: stdSerializers.err,
      // 요청/응답은 상관관계에 필요한 최소치로 줄인다.
      //
      // 이유 둘. (1) `x-api-key`가 헤더에 실려 오므로 헤더를 그대로 남기면 공유 시크릿이
      // 매 요청 로그에 평문으로 기록된다. (2) GeoQueue.add가 요청 핸들러 스택 안에서 돌아
      // nestjs-pino의 요청 컨텍스트가 백그라운드 작업 로그까지 따라온다 — 헤더 전체를 두면
      // 작업 로그 한 줄마다 요청 헤더가 복제된다. reqId만 남으면 상관관계는 그대로 유지된다.
      req: (req: { id?: unknown; method?: unknown; url?: unknown }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode?: unknown }) => ({ statusCode: res.statusCode }),
    },
    // serializer가 헤더를 이미 떨어내지만, 나중에 serializer가 넓어질 때를 대비한 2차 방어선.
    redact: {
      paths: ['req.headers["x-api-key"]', "req.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    },
    mixin: () => currentJobContext() ?? {},
    // 호출자가 level/time을 넘겨도 고정 필드가 이긴다 — 레벨과 시각은 로그의 신뢰 기준이다.
    mixinMergeStrategy: (mergeObject, mixinObject) => ({ ...mergeObject, ...mixinObject }),
  };
}
