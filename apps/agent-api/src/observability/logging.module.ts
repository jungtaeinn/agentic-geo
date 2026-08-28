import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildPinoOptions } from "./logger-options";

/**
 * 서비스 전역 JSON 로깅 (GEO-222).
 *
 * nestjs-pino가 Nest의 LoggerService를 대체하므로 프레임워크 부팅 로그까지 같은 JSON으로 나온다.
 * HTTP 요청 1건은 요청 스코프 컨텍스트(reqId)를 갖고, 백그라운드 작업은 job-context가 담당한다
 * (작업은 202 응답 이후에 돌아 요청 스코프를 벗어나므로 별도 컨텍스트가 필요하다).
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        ...buildPinoOptions(),
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const existing = req.headers["x-request-id"];
          const id = typeof existing === "string" && existing !== "" ? existing : randomUUID();
          res.setHeader("x-request-id", id);
          return id;
        },
        // 프로브가 초당 수차례 때리므로 요청 로그에서 제외한다.
        autoLogging: { ignore: (req: IncomingMessage) => req.url === "/health" },
        customProps: () => ({ event: "http.request" }),
      },
    }),
  ],
})
export class LoggingModule {}
