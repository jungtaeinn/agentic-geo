import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { GeoController } from "../src/geo/geo.controller";
import { GeoAcceptService } from "../src/geo/geo-accept.service";

describe("GeoController (e2e)", () => {
  let app: INestApplication;
  const accept = jest.fn();

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [GeoController],
      providers: [{ provide: GeoAcceptService, useValue: { accept } }],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns 202 for a valid submission", async () => {
    accept.mockResolvedValueOnce("enqueued");
    const res = await request(app.getHttpServer())
      .post("/internal/v1/geo/generations")
      .send({ geoGenerationId: "550e8400-e29b-41d4-a716-446655440000", locale: "ko-KR", product: { a: 1 } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, geoGenerationId: "550e8400-e29b-41d4-a716-446655440000" });
  });

  it("returns 400 for invalid body", async () => {
    await request(app.getHttpServer())
      .post("/internal/v1/geo/generations")
      .send({ geoGenerationId: "not-a-uuid", locale: "", product: "x" })
      .expect(400);
  });
});
