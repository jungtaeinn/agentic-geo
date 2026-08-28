import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { ApiKeyGuard } from "../src/auth/api-key.guard";
import { HealthController } from "../src/health/health.controller";

@Controller("secure")
class SecureController {
  @Get()
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

function makeModule(apiKey: string) {
  @Module({
    controllers: [SecureController, HealthController],
    providers: [{ provide: APP_GUARD, useValue: new ApiKeyGuard(apiKey) }],
  })
  class TestModule {}
  return TestModule;
}

describe("ApiKeyGuard (e2e)", () => {
  async function boot(apiKey: string): Promise<INestApplication> {
    const ref = await Test.createTestingModule({ imports: [makeModule(apiKey)] }).compile();
    const app = ref.createNestApplication();
    await app.init();
    return app;
  }

  it("rejects missing/invalid key with 401 when key configured", async () => {
    const app = await boot("secret");
    await request(app.getHttpServer()).get("/secure").expect(401);
    await request(app.getHttpServer()).get("/secure").set("x-api-key", "wrong").expect(401);
    await request(app.getHttpServer()).get("/secure").set("x-api-key", "secret").expect(200);
    await app.close();
  });

  it("allows /health without key", async () => {
    const app = await boot("secret");
    await request(app.getHttpServer()).get("/health").expect(200);
    await app.close();
  });

  it("allows all when key not configured", async () => {
    const app = await boot("");
    await request(app.getHttpServer()).get("/secure").expect(200);
    await app.close();
  });
});
