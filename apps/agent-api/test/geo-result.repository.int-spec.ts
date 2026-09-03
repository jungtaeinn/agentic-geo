import type { StartedDb } from "./utils/db";
import { startPostgres } from "./utils/db";
import { GeoGeneration } from "../src/geo/persistence/geo-generation.entity";
import { GeoResult } from "../src/geo/persistence/geo-result.entity";

describe("geo entities (Testcontainers)", () => {
  let db: StartedDb;
  const id = "11111111-1111-1111-1111-111111111111";

  beforeAll(async () => {
    db = await startPostgres();
  });
  afterAll(async () => {
    await db.dataSource.destroy();
    await db.container.stop();
  });

  it("persists a generation and a result row", async () => {
    await db.dataSource.getRepository(GeoGeneration).query(
      `insert into agentic_geo.geo_generation
       (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status, version, created_at, updated_at)
       values ($1,$2,'h','ko-KR','{}','SN-TEST','PROCESSING',0,now(),now())`,
      [id, db.testChannelId],
    );
    const result = db.dataSource.getRepository(GeoResult).create({
      geoGenerationId: id,
      resultStatus: "SUCCEEDED",
      jsonLd: { "@type": "Product" },
      scriptTag: "<script></script>",
      schemaTypes: ["Product"],
      resultHash: "abc",
      ragProfile: "pdp-geo-generator-default",
      diagnostics: {},
      generatedAt: new Date(),
    });
    await db.dataSource.getRepository(GeoResult).save(result);

    const count = await db.dataSource.getRepository(GeoResult).count();
    expect(count).toBe(1);
  });
});
