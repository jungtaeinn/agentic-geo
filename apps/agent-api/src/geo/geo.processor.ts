import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { GeoQueue, type GeoQueueJob } from "./geo-queue.service";
import { GenerationService } from "./generation.service";
import { GeoResultRepository } from "./persistence/geo-result.repository";
import { GeoGenerationRepository } from "./persistence/geo-generation.repository";

@Injectable()
export class GeoProcessor implements OnModuleInit {
  private readonly logger = new Logger(GeoProcessor.name);

  constructor(
    private readonly queue: GeoQueue,
    private readonly generation: GenerationService,
    private readonly results: GeoResultRepository,
    private readonly generations: GeoGenerationRepository,
  ) {}

  onModuleInit(): void {
    this.queue.setHandler((job) => this.process(job));
  }

  async process(job: GeoQueueJob): Promise<void> {
    const { geoGenerationId, locale, product, brandSameAs } = job.data;
    try {
      const artifact = await this.generation.generate({ geoGenerationId, locale, product, brandSameAs });
      const persisted = await this.results.persistSuccess(geoGenerationId, artifact);
      if (!persisted) {
        this.logger.warn({ event: "geo.persist_skipped", geoGenerationId, reason: "not PROCESSING" });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 마지막 시도에서만 FAILED 마킹 (그 전엔 큐의 백오프 재시도에 맡긴다)
      if (job.attemptsMade + 1 >= this.queue.maxAttempts) {
        try {
          await this.generations.transitionToFailed(geoGenerationId, "GENERATION_ERROR", detail.slice(0, 2000));
        } catch (transitionError) {
          // 상태 전이 실패(DB 블립)로 원인 에러가 가려지지 않도록 별도로 로깅만 하고 원래 에러를 그대로 던진다
          this.logger.error({ event: "geo.transition_failed", geoGenerationId, err: transitionError });
        }
      }
      throw error;
    }
  }
}
