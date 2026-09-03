import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { GeoGeneration } from "./persistence/geo-generation.entity";
import { GeoResult } from "./persistence/geo-result.entity";
import { GeoGenerationRepository } from "./persistence/geo-generation.repository";
import { GeoResultRepository } from "./persistence/geo-result.repository";
import { GeoQueue } from "./geo-queue.service";
import { GeoAcceptService } from "./geo-accept.service";
import { GenerationService } from "./generation.service";
import { OcrEnrichmentService } from "./ocr-enrichment.service";
import { GeoController } from "./geo.controller";
import { GeoTestController } from "./geo-test.controller";
import { GeoProcessor } from "./geo.processor";
import { loadConfig } from "../config/configuration";

/** BullMQ `{ attempts: 2, backoff: { type: "exponential", delay: 5000 } }`와 동일한 파라미터. */
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 5000;

@Module({
  imports: [TypeOrmModule.forFeature([GeoGeneration, GeoResult])],
  controllers: [GeoController, GeoTestController],
  providers: [
    {
      provide: GeoQueue,
      useFactory: () =>
        new GeoQueue({
          concurrency: loadConfig().workerConcurrency,
          maxAttempts: MAX_ATTEMPTS,
          backoffMs: BACKOFF_MS,
        }),
    },
    GeoGenerationRepository,
    GeoResultRepository,
    GeoAcceptService,
    OcrEnrichmentService,
    GenerationService,
    GeoProcessor,
  ],
  exports: [GeoAcceptService],
})
export class GeoModule {}
