import { resolveResultStatus } from "../src/geo/generation.service";

describe("resolveResultStatus", () => {
  it("returns SUCCEEDED when there are no warnings", () => {
    expect(resolveResultStatus([])).toBe("SUCCEEDED");
  });

  it("returns SUCCEEDED_WITH_WARNINGS when warnings are present", () => {
    expect(resolveResultStatus(["ocr partial failure"])).toBe("SUCCEEDED_WITH_WARNINGS");
  });
});
