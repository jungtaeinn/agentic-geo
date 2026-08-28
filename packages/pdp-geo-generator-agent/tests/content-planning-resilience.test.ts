import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import type { PdpGeoContentPlan } from "../src/types";

/**
 * A single transient transport failure ("fetch failed") must not silently
 * downgrade the whole run: the planning call retries once for transport
 * errors, and when planning stays unavailable the degradation is stated
 * explicitly instead of being buried as a bare error message.
 */

const product = {
  geoProduct: {
    name: "Barrier Hydro Soothing Cream",
    brand: "Test Brand",
    category: "Cream",
    description: "Hydrating cream for dry skin and skin barrier care.",
    benefits: ["hydration", "skin barrier care"]
  }
};

const emptyPlannedField = {
  include: false,
  text: "",
  intent: "product-entity-summary",
  evidenceIds: [],
  confidence: 0,
  omitReason: "insufficient evidence"
};

const minimalValidPlan: Omit<PdpGeoContentPlan, "mode"> = {
  locale: "en-US",
  productDescription: emptyPlannedField,
  webPageDescription: { ...emptyPlannedField, intent: "page-coverage-summary" },
  faq: [],
  howTo: { eligible: false, ordered: false, goal: "", steps: [], evidenceIds: [], confidence: 0, omitReason: "no usage actions" },
  cep: [],
  warnings: []
};

describe("content planning transport resilience", () => {
  it("retries once on a transient transport error and recovers to a model plan", async () => {
    let calls = 0;
    const run = await generatePdpGeo({ product, hints: { locale: "en-US", market: "US" } }, {
      provider: "custom",
      customContentPlanner: {
        async planContent() {
          calls += 1;
          if (calls === 1) {
            throw new TypeError("fetch failed");
          }
          return { plan: minimalValidPlan };
        }
      }
    });

    expect(calls).toBe(2);
    expect(run.diagnostics.contentPlan?.mode).toBe("model");
    expect(run.diagnostics.contentPlan?.warnings.join(" ")).toMatch(/transient/i);
  });

  it("fails closed with an explicit degraded-mode warning when the transport stays down", async () => {
    let calls = 0;
    const run = await generatePdpGeo({ product, hints: { locale: "en-US", market: "US" } }, {
      provider: "custom",
      customContentPlanner: {
        async planContent() {
          calls += 1;
          throw new TypeError("fetch failed");
        }
      }
    });

    expect(calls).toBe(2);
    expect(run.diagnostics.contentPlan?.mode).toBe("conservative");
    expect(run.diagnostics.contentPlan?.warnings.join(" ")).toMatch(/DEGRADED_MODE/);
    // The degradation must be visible in the run's process log, not only
    // buried inside diagnostics.
    expect(JSON.stringify(run.process)).toMatch(/보수적|DEGRADED/i);
  });

  it("does not retry a non-transient planner error", async () => {
    let calls = 0;
    const run = await generatePdpGeo({ product, hints: { locale: "en-US", market: "US" } }, {
      provider: "custom",
      customContentPlanner: {
        async planContent() {
          calls += 1;
          throw new Error("provider rejected the planning schema");
        }
      }
    });

    expect(calls).toBe(1);
    expect(run.diagnostics.contentPlan?.mode).toBe("conservative");
  });

  it("does not retry a timeout so a long hang is not doubled", async () => {
    let calls = 0;
    const run = await generatePdpGeo({ product, hints: { locale: "en-US", market: "US" } }, {
      provider: "custom",
      customContentPlanner: {
        async planContent() {
          calls += 1;
          throw new Error("Content planning timed out");
        }
      }
    });

    expect(calls).toBe(1);
    expect(run.diagnostics.contentPlan?.mode).toBe("conservative");
  });
});
