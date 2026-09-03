import { startPostgres, type StartedDb } from "./utils/db";
import { GeoGenerationRepository } from "../src/geo/persistence/geo-generation.repository";
import { GeoGeneration } from "../src/geo/persistence/geo-generation.entity";

describe("GeoGenerationRepository guarded transitions", () => {
  let db: StartedDb;
  let repo: GeoGenerationRepository;
  const id = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    db = await startPostgres();
    repo = new GeoGenerationRepository(db.dataSource.getRepository(GeoGeneration));
  });
  afterAll(async () => {
    await db.dataSource.destroy();
    await db.container.stop();
  });

  async function seed(status: string): Promise<void> {
    await db.dataSource.query(
      `insert into agentic_geo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, claimed_at, claimed_by, created_at, updated_at)
       values ($1,$2,$3,'ko-KR','{}','SN-TEST',$4,0,now(),'batch-1',now(),now())
       on conflict (geo_generation_id) do update set status=excluded.status, version=0, claimed_by='batch-1', claimed_at=now()`,
      [id, db.testChannelId, id, status],
    );
  }

  it("transitions PROCESSING -> SUCCEEDED once (idempotent)", async () => {
    await seed("PROCESSING");
    expect(await repo.transitionToSucceeded(id)).toBe(true);
    expect(await repo.findStatus(id)).toBe("SUCCEEDED");
    // 두 번째 호출은 이미 SUCCEEDED이므로 no-op
    expect(await repo.transitionToSucceeded(id)).toBe(false);

    const row = await db.dataSource.query(
      "select version, claimed_at, claimed_by from agentic_geo.geo_generation where geo_generation_id=$1",
      [id],
    );
    expect(Number(row[0].version)).toBe(1);
    expect(row[0].claimed_at).toBeNull();
    expect(row[0].claimed_by).toBeNull();
  });

  it("transitions PROCESSING -> FAILED with error phase", async () => {
    await seed("PROCESSING");
    expect(await repo.transitionToFailed(id, "GEN_ERROR", "boom")).toBe(true);
    const row = await db.dataSource.query(
      "select status, error_phase, error_code, error_detail from agentic_geo.geo_generation where geo_generation_id=$1",
      [id],
    );
    expect(row[0].status).toBe("FAILED");
    expect(row[0].error_phase).toBe("GENERATION");
    expect(row[0].error_code).toBe("GEN_ERROR");
  });

  it("does not transition when not PROCESSING", async () => {
    await seed("FAILED");
    expect(await repo.transitionToSucceeded(id)).toBe(false);
    expect(await repo.findStatus(id)).toBe("FAILED");
  });

  it("returns null status for an unknown geoGenerationId", async () => {
    expect(await repo.findStatus("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
