import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { initLangfuse } from "./observability/langfuse";

async function bootstrap(): Promise<void> {
  const langfuseEnabled = initLangfuse();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // useLogger 전에 발생하는 부팅 로그를 버퍼에 담아두고, 로거가 붙은 뒤 JSON으로 흘린다.
    // 이게 없으면 Nest 자체 부팅 로그만 텍스트로 남아 스트림이 두 포맷으로 섞인다 (GEO-222).
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  app.useBodyParser("json", { limit: "2mb" });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // GeoQueue.onApplicationShutdown이 SIGTERM에서 실제로 호출되게 한다 (GEO-221)
  app.enableShutdownHooks();

  if (langfuseEnabled) {
    logger.log({ event: "langfuse.enabled", baseUrl: process.env.LANGFUSE_BASE_URL ?? "cloud" });
  }

  const config = loadConfig();
  await app.listen(config.port);
  logger.log({ event: "app.listening", port: config.port });
}

void bootstrap();
