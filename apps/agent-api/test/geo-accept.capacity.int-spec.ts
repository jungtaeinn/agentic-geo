import { startPostgres, type StartedDb } from "./utils/db";
import { GeoGenerationRepository } from "../src/geo/persistence/geo-generation.repository";
import { GeoGeneration } from "../src/geo/persistence/geo-generation.entity";
import { GeoAcceptService } from "../src/geo/geo-accept.service";
import { GeoQueue } from "../src/geo/geo-queue.service";

describe("GeoAcceptService capacity", () => {
  let db: StartedDb;
  let queue: GeoQueue;

  beforeAll(async () => {
    process.env.GEO_QUEUE_MAX_WAITING = "1";
    db = await startPostgres();
    queue = new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 5000 });
  });
  afterAll(async () => {
    queue.onApplicationShutdown();
    await db.dataSource.destroy();
    await db.container.stop();
  });

  it("throws 429 when waiting jobs exceed the cap", async () => {
    const repo = new GeoGenerationRepository(db.dataSource.getRepository(GeoGeneration));
    const service = new GeoAcceptService(queue, repo);
    // 핸들러 미등록 상태라 add한 잡은 대기열에 남는다. cap=1 초과로 2건 주입.
    queue.add({ geoGenerationId: "x1", locale: "ko-KR", product: {} });
    queue.add({ geoGenerationId: "x2", locale: "ko-KR", product: {} });
    expect(queue.getWaitingCount()).toBe(2);

    const id = "77777777-7777-7777-7777-777777777777";
    await db.dataSource.query(
      `insert into agentic_geo.geo_generation (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{}','SN-TEST','PROCESSING',0,now(),now())`,
      [id, db.testChannelId, id],
    );
    await expect(service.accept({ geoGenerationId: id, locale: "ko-KR", product: {} })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("throws 503 when the datastore is unavailable", async () => {
    const throwingRepo = {
      findStatus: async () => {
        throw new Error("db down");
      },
    } as unknown as GeoGenerationRepository;
    const svc = new GeoAcceptService(queue, throwingRepo);
    await expect(
      svc.accept({ geoGenerationId: "550e8400-e29b-41d4-a716-446655440123", locale: "ko-KR", product: {} }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
