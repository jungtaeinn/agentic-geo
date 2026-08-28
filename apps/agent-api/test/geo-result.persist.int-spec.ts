import { startPostgres, type StartedDb } from "./utils/db";
import { GeoResultRepository } from "../src/geo/persistence/geo-result.repository";
import type { GeneratedArtifact } from "../src/geo/generation.service";

const artifact: GeneratedArtifact = {
  resultStatus: "SUCCEEDED",
  jsonLd: { "@type": "Product" },
  scriptTag: "<script></script>",
  schemaTypes: ["Product"],
  resultHash: "a".repeat(64),
  ragProfile: "pdp-geo-generator-default",
  diagnostics: {},
  // 저장 경로는 contentSections를 쓰지 않지만(리포지토리가 필드를 명시적으로 고른다)
  // 아티팩트 계약을 채워야 이 픽스처가 실제 산출물과 같은 모양이 된다.
  contentSections: {
    productName: "Product",
    description: "",
    quickFacts: "",
    benefits: "",
    ingredients: "",
    howToUse: "",
    faq: "",
  },
  generatedAt: new Date().toISOString(),
};

describe("GeoResultRepository.persistSuccess (transactional)", () => {
  let db: StartedDb;
  let repo: GeoResultRepository;
  const id = "33333333-3333-3333-3333-333333333333";

  beforeAll(async () => {
    db = await startPostgres();
    repo = new GeoResultRepository(db.dataSource);
  });
  afterAll(async () => {
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

  it("writes result and flips status in one transaction", async () => {
    await seed("PROCESSING");
    expect(await repo.persistSuccess(id, artifact)).toBe(true);
    const res = await db.dataSource.query("select count(*)::int c from neo.geo_result where geo_generation_id=$1", [id]);
    const gen = await db.dataSource.query("select status from neo.geo_generation where geo_generation_id=$1", [id]);
    expect(res[0].c).toBe(1);
    expect(gen[0].status).toBe("SUCCEEDED");
  });

  it("rolls back result insert when status is not PROCESSING", async () => {
    await seed("FAILED");
    await db.dataSource.query("delete from neo.geo_result where geo_generation_id=$1", [id]);
    expect(await repo.persistSuccess(id, artifact)).toBe(false);
    const res = await db.dataSource.query("select count(*)::int c from neo.geo_result where geo_generation_id=$1", [id]);
    expect(res[0].c).toBe(0);
  });
});
