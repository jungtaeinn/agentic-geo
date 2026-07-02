import { describe, expect, it } from "vitest";
import { readGeoCitationRagProfile } from "../src";

describe("citation-ready content contract", () => {
  it("loads the mandatory anti-promo and Reddit balance rules", async () => {
    const profile = await readGeoCitationRagProfile();
    const contract = profile.mandatoryDocuments.find((document) => document.name === "citation-ready-content-contract_v1.md");

    expect(contract?.content).toContain("must not generate promotional content");
    expect(contract?.content).toContain("Reddit Balance Rule");
    expect(contract?.content).toContain("AI retrieval systems need clear answer chunks");
    expect(profile.mandatoryDocuments.map((document) => document.name)).toEqual([
      "citation-ready-content-contract_v1.md",
      "geo-citation-readiness_v1.md",
      "eeat_v1.md",
      "cep_v1.md",
      "claim-safety_v1.md"
    ]);
  });
});
