import { startPostgres, type StartedDb } from "./utils/db";
import { GeoGenerationRepository } from "../src/geo/persistence/geo-generation.repository";
import { GeoGeneration } from "../src/geo/persistence/geo-generation.entity";
import { GeoAcceptService } from "../src/geo/geo-accept.service";
import { GeoQueue } from "../src/geo/geo-queue.service";

describe("GeoAcceptService (idempotent enqueue)", () => {
  let db: StartedDb;
  let queue: GeoQueue;
  let service: GeoAcceptService;
  const id = "44444444-4444-4444-4444-444444444444";

  beforeAll(async () => {
    db = await startPostgres();
    // 핸들러를 등록하지 않아 잡이 대기열에 머문다 — 접수 로직만 검증한다.
    queue = new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 5000 });
    const repo = new GeoGenerationRepository(db.dataSource.getRepository(GeoGeneration));
    service = new GeoAcceptService(queue, repo);
  });
  afterAll(async () => {
    queue.onApplicationShutdown();
    await db.dataSource.destroy();
    await db.container.stop();
  });

  async function seed(status: string): Promise<void> {
    await db.dataSource.query(
      `insert into neo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{}','SN-TEST',$4,0,now(),now())
       on conflict (geo_generation_id) do update set status=excluded.status`,
      [id, db.testChannelId, id, status],
    );
  }

  it("enqueues once for PROCESSING and dedups by geoGenerationId", async () => {
    await seed("PROCESSING");
    expect(await service.accept({ geoGenerationId: id, locale: "ko-KR", product: {} })).toBe("enqueued");
    // 동일 id 재접수 → 큐에는 여전히 1건
    await service.accept({ geoGenerationId: id, locale: "ko-KR", product: {} });
    expect(queue.getWaitingCount()).toBe(1);
  });

  it("no-ops when status is not PROCESSING", async () => {
    const otherId = "55555555-5555-5555-5555-555555555555";
    await db.dataSource.query(
      `insert into neo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{}','SN-TEST','SUCCEEDED',0,now(),now())`,
      [otherId, db.testChannelId, otherId],
    );
    expect(await service.accept({ geoGenerationId: otherId, locale: "ko-KR", product: {} })).toBe("noop");
  });
});
