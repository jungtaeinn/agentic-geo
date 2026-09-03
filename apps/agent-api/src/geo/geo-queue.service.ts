import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { GeoJobData } from "./geo-job.types";
import { runInJobContext } from "../observability/job-context";

export interface GeoQueueJob {
  data: GeoJobData;
  /** 0-based. 이 시도 이전에 완료된 시도 횟수 (BullMQ `job.attemptsMade`와 동일 의미). */
  attemptsMade: number;
}

export type GeoQueueHandler = (job: GeoQueueJob) => Promise<void>;

export interface GeoQueueOptions {
  concurrency: number;
  maxAttempts: number;
  backoffMs: number;
}

/**
 * 인프로세스 작업 큐 (GEO-221).
 * 대기열·동시성 상한·dedup·백오프 재시도만 담당하며 작업 내용은 알지 못한다.
 *
 * 내구성은 없다 — 재시작 시 대기·진행 중 작업은 유실되고, 해당 row는
 * `geo_generation.status='PROCESSING'`으로 남아 dispatcher stale sweep(15분)이 회수한다.
 */
@Injectable()
export class GeoQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(GeoQueue.name);

  readonly concurrency: number;
  readonly maxAttempts: number;
  private readonly backoffMs: number;

  private readonly waiting: GeoQueueJob[] = [];
  /** 대기·실행·백오프 대기 중인 모든 id. dedup의 단일 진실. */
  private readonly tracked = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private active = 0;
  private stopped = false;
  private handler: GeoQueueHandler | null = null;

  constructor(options: GeoQueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error(
        `GeoQueue concurrency는 1 이상의 정수여야 합니다 (받은 값: ${options.concurrency})`,
      );
    }
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error(
        `GeoQueue maxAttempts는 1 이상의 정수여야 합니다 (받은 값: ${options.maxAttempts})`,
      );
    }
    if (!Number.isFinite(options.backoffMs) || options.backoffMs < 0) {
      throw new Error(
        `GeoQueue backoffMs는 0 이상의 유한한 숫자여야 합니다 (받은 값: ${options.backoffMs})`,
      );
    }

    this.concurrency = options.concurrency;
    this.maxAttempts = options.maxAttempts;
    this.backoffMs = options.backoffMs;
  }

  setHandler(handler: GeoQueueHandler): void {
    this.handler = handler;
    this.pump();
  }

  add(data: GeoJobData): void {
    if (this.stopped) return;
    if (this.tracked.has(data.geoGenerationId)) return;
    this.tracked.add(data.geoGenerationId);
    this.waiting.push({ data, attemptsMade: 0 });
    this.pump();
  }

  getWaitingCount(): number {
    return this.waiting.length;
  }

  /** 실행 중 작업 수. 큐 깊이를 로그로 관측하기 위해 노출한다. */
  get activeCount(): number {
    return this.active;
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    const discarded = this.waiting.length;
    this.waiting.length = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (discarded > 0) {
      this.logger.warn({
        event: "queue.discarded_on_shutdown",
        discarded,
        note: "dispatcher stale sweep will reclaim them",
      });
    }
  }

  private pump(): void {
    if (this.handler === null) return;
    while (!this.stopped && this.active < this.concurrency && this.waiting.length > 0) {
      void this.run(this.waiting.shift() as GeoQueueJob);
    }
  }

  private async run(job: GeoQueueJob): Promise<void> {
    const handler = this.handler as GeoQueueHandler;
    const id = job.data.geoGenerationId;
    const attempt = job.attemptsMade + 1;
    this.active += 1;
    const startedAt = Date.now();
    try {
      // 작업 전 구간(핸들러가 부르는 모든 코드 포함)의 로그에 id·attempt가 자동으로 붙는다.
      await runInJobContext({ geoGenerationId: id, attempt }, async () => {
        this.logger.log({
          event: "job.started",
          maxAttempts: this.maxAttempts,
          active: this.active,
          waiting: this.waiting.length,
        });
        await handler(job);
        this.logger.log({
          event: "job.completed",
          durationMs: Date.now() - startedAt,
          active: this.active - 1,
          waiting: this.waiting.length,
        });
      });
      this.tracked.delete(id);
    } catch (error) {
      this.scheduleRetryOrDrop(job, error);
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private scheduleRetryOrDrop(job: GeoQueueJob, error: unknown): void {
    const id = job.data.geoGenerationId;
    const attemptsDone = job.attemptsMade + 1;

    if (this.stopped || attemptsDone >= this.maxAttempts) {
      this.tracked.delete(id);
      this.logger.error({
        event: "job.failed",
        geoGenerationId: id,
        attempts: attemptsDone,
        maxAttempts: this.maxAttempts,
        err: error,
      });
      return;
    }

    const delay = this.backoffMs * 2 ** job.attemptsMade;
    this.logger.warn({
      event: "job.retrying",
      geoGenerationId: id,
      attempt: attemptsDone,
      maxAttempts: this.maxAttempts,
      delayMs: delay,
      err: error,
    });

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) {
        this.tracked.delete(id);
        return;
      }
      this.waiting.unshift({ data: job.data, attemptsMade: attemptsDone });
      this.pump();
    }, delay);
    this.timers.add(timer);
  }
}
