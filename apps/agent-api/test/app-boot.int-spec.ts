import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { startPostgres, type StartedDb } from "./utils/db";

/**
 * 인프라 백업 AppModule 부팅 통합 테스트.
 * TypeOrmModule.forRoot가 실제 Postgres 연결로 부팅되는지 검증한다
 * (지금껏 HealthController만 단독 부팅하는 e2e-spec에는 없던 커버리지).
 *
 * AppModule의 @Module 데코레이터는 import 시점에 loadConfig()를 평가해
 * TypeOrmModule.forRoot 옵션을 고정한다.
 * 따라서 컨테이너 기동 후 env를 먼저 주입하고, 그 다음에 AppModule을 동적 import 해야 한다.
 */
describe("AppModule boot (integration, real Postgres)", () => {
  let db: StartedDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startPostgres();

    process.env.DB_HOST = db.container.getHost();
    process.env.DB_PORT = String(db.container.getPort());
    process.env.DB_NAME = db.container.getDatabase();
    process.env.DB_USERNAME = db.container.getUsername();
    process.env.DB_PASSWORD = db.container.getPassword();
    process.env.DB_SCHEMA = "agentic_geo";
    process.env.AGENTIC_GEO_PROVIDER = "mock";
    // AGENT_API_KEY는 의도적으로 비워둔다 — 미설정 시 ApiKeyGuard가 통과시키므로 /health는 키 없이 200이어야 한다.
    delete process.env.AGENT_API_KEY;

    const { Test } = await import("@nestjs/testing");
    const { AppModule } = await import("../src/app.module");

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await db.dataSource.destroy();
    await db.container.stop();
  });

  it("boots the full AppModule against real infra and GET /health returns 200", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  }, 60000);
});
