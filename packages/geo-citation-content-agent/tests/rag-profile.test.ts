import { describe, expect, it } from "vitest";
import {
  geoCitationRagIndex,
  readGeoCitationRagProfile
} from "../src";

describe("RAG profile", () => {
  it("separates mandatory RAG from reddit surface RAG", async () => {
    const profile = await readGeoCitationRagProfile();

    expect(profile.profile).toBe("geo-citation-content-default");
    expect(profile.mandatoryDocuments.every((document) => document.mandatory)).toBe(true);
    expect(profile.surfaceDocuments.reddit.every((document) => document.surface === "reddit")).toBe(true);
    expect(profile.surfaceDocuments.reddit.map((document) => document.name)).toEqual([
      "reddit-content-guidelines_v1.md",
      "reddit-post-patterns_v1.md"
    ]);
    expect(geoCitationRagIndex.some((entry) => entry.document === "claim-safety_v1.md" && entry.mandatory)).toBe(true);
  });
});
