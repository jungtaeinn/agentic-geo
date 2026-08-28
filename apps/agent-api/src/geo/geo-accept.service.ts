import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { GeoQueue } from "./geo-queue.service";
import type { GeoJobData } from "./geo-job.types";
import { GeoGenerationRepository } from "./persistence/geo-generation.repository";

function parseMaxWaiting(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 100;
}

@Injectable()
export class GeoAcceptService {
  private readonly logger = new Logger(GeoAcceptService.name);

  constructor(
    private readonly queue: GeoQueue,
    private readonly generations: GeoGenerationRepository,
  ) {}

  async accept(dto: GeoJobData): Promise<"enqueued" | "noop"> {
    let status: string | null;
    try {
      status = await this.generations.findStatus(dto.geoGenerationId);
    } catch (error) {
      this.logger.error({
        event: "geo.accept.db_unavailable",
        geoGenerationId: dto.geoGenerationId,
        err: error,
      });
      throw new ServiceUnavailableException("db unavailable");
    }
    if (status !== "PROCESSING") {
      this.logger.log({ event: "geo.noop", geoGenerationId: dto.geoGenerationId, status });
      return "noop";
    }

    const maxWaiting = parseMaxWaiting(process.env.GEO_QUEUE_MAX_WAITING);
    const waiting = this.queue.getWaitingCount();
    if (waiting >= maxWaiting) {
      this.logger.warn({
        event: "geo.rejected.saturated",
        geoGenerationId: dto.geoGenerationId,
        waiting,
        maxWaiting,
      });
      throw new HttpException("queue saturated", HttpStatus.TOO_MANY_REQUESTS);
    }

    // add()가 동기적으로 작업을 시작시키므로, 수락 로그를 먼저 남겨야 로그가 인과 순서대로 읽힌다.
    // 큐 깊이는 수락 판정 시점의 값이라 429 임계값과 같은 기준으로 해석된다.
    this.logger.log({
      event: "geo.accepted",
      geoGenerationId: dto.geoGenerationId,
      locale: dto.locale,
      waiting,
      active: this.queue.activeCount,
      maxWaiting,
    });
    // 인프로세스 큐라 실패하지 않는다. dedup은 큐가 담당한다.
    this.queue.add(dto);
    return "enqueued";
  }
}
