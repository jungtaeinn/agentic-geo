import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { startPostgres, type StartedDb } from "./utils/db";
import { GeoGeneration } from "../src/geo/persistence/geo-generation.entity";
import { GeoResult } from "../src/geo/persistence/geo-result.entity";
import { GeoGenerationRepository } from "../src/geo/persistence/geo-generation.repository";
import { GeoResultRepository } from "../src/geo/persistence/geo-result.repository";
import { GenerationService } from "../src/geo/generation.service";
import { GeoProcessor } from "../src/geo/geo.processor";
import { GeoQueue } from "../src/geo/geo-queue.service";

describe("GeoProcessor (end-to-end, mock provider)", () => {
  let db: StartedDb;
  let moduleRef: TestingModule;
  let queue: GeoQueue;
  const id = "66666666-6666-6666-6666-666666666666";

  beforeAll(async () => {
    process.env.AGENTIC_GEO_PROVIDER = "mock";
    db = await startPostgres();

    // 백오프를 10ms로 낮춰 재시도 소진 시나리오가 5초를 기다리지 않게 한다.
    queue = new GeoQueue({ concurrency: 4, maxAttempts: 2, backoffMs: 10 });

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          host: db.container.getHost(),
          port: db.container.getPort(),
          username: db.container.getUsername(),
          password: db.container.getPassword(),
          database: db.container.getDatabase(),
          entities: [GeoGeneration, GeoResult],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([GeoGeneration, GeoResult]),
      ],
      providers: [
        { provide: GeoQueue, useValue: queue },
        GeoGenerationRepository,
        GeoResultRepository,
        GenerationService,
        GeoProcessor,
      ],
    }).compile();
    await moduleRef.init();
  }, 180000);

  afterAll(async () => {
    queue.onApplicationShutdown();
    await moduleRef.close();
    await db.dataSource.destroy();
    await db.container.stop();
  });

  async function waitForTerminalStatus(generationId: string): Promise<string> {
    const deadline = Date.now() + 120000;
    let status = "";
    while (Date.now() < deadline) {
      const row = await db.dataSource.query(
        "select status from neo.geo_generation where geo_generation_id=$1",
        [generationId],
      );
      status = row[0].status;
      if (status === "SUCCEEDED" || status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return status;
  }

  it("processes a job: generates and persists SUCCEEDED", async () => {
    await db.dataSource.query(
      `insert into neo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{"item":{"title":"Cream"}}','SN-TEST','PROCESSING',0,now(),now())`,
      [id, db.testChannelId, id],
    );
    queue.add({ geoGenerationId: id, locale: "ko-KR", product: { item: { title: "Cream" } } });

    expect(await waitForTerminalStatus(id)).toBe("SUCCEEDED");
    const res = await db.dataSource.query(
      "select count(*)::int c from neo.geo_result where geo_generation_id=$1",
      [id],
    );
    expect(res[0].c).toBe(1);
  }, 180000);

  it("retries once, then marks FAILED with error_phase=GENERATION when attempts are exhausted", async () => {
    const failId = "550e8400-e29b-41d4-a716-446655440099";
    await db.dataSource.query(
      `insert into neo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{"item":{"title":"X"}}','SN-TEST','PROCESSING',0,now(),now())`,
      [failId, db.testChannelId, failId],
    );

    const gen = moduleRef.get(GenerationService);
    // maxAttempts=2 → 두 번 다 실패해야 FAILED로 간다.
    const spy = jest.spyOn(gen, "generate").mockRejectedValue(new Error("boom"));

    queue.add({ geoGenerationId: failId, locale: "ko-KR", product: { item: { title: "X" } } });

    expect(await waitForTerminalStatus(failId)).toBe("FAILED");
    expect(spy).toHaveBeenCalledTimes(2);

    const failRow = await db.dataSource.query(
      "select error_phase, error_code from neo.geo_generation where geo_generation_id=$1",
      [failId],
    );
    expect(failRow[0].error_phase).toBe("GENERATION");
    expect(failRow[0].error_code).toBe("GENERATION_ERROR");

    const res = await db.dataSource.query(
      "select count(*)::int c from neo.geo_result where geo_generation_id=$1",
      [failId],
    );
    expect(res[0].c).toBe(0);
    spy.mockRestore();
  }, 180000);
});
