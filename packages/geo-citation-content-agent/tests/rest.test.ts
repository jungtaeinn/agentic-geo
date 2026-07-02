import { describe, expect, it } from "vitest";
import {
  createGeoCitationContentRestHandler,
  createMockGeoCitationContentInput
} from "../src";

describe("REST adapter", () => {
  it("returns a Reddit citation artifact from a POST request", async () => {
    const handler = createGeoCitationContentRestHandler();
    const response = await handler(new Request("https://example.com/api/geo-citation-content", {
      method: "POST",
      body: JSON.stringify(createMockGeoCitationContentInput())
    }));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.result.artifact.surface).toBe("reddit");
    expect(body.diagnostics.geoCitationReadiness.passed).toBe(true);
    expect(body.diagnostics.evidence.some((item: any) => item.field === "readiness.geoCitation")).toBe(true);
    expect(body.process.some((step: any) => step.id === "artifact" && step.status === "done")).toBe(true);
  });

  it("rejects non-POST requests", async () => {
    const handler = createGeoCitationContentRestHandler();
    const response = await handler(new Request("https://example.com/api/geo-citation-content", {
      method: "GET"
    }));

    expect(response.status).toBe(405);
  });
});
