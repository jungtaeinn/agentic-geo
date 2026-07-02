import { describe, expect, it } from "vitest";
import {
  getSurfaceProfile,
  isSupportedGeoCitationSurface,
  listSupportedGeoCitationSurfaces
} from "../src";

describe("surface registry", () => {
  it("supports reddit now and keeps other surfaces closed at runtime", () => {
    expect(listSupportedGeoCitationSurfaces()).toEqual(["reddit"]);
    expect(isSupportedGeoCitationSurface("reddit")).toBe(true);
    expect(isSupportedGeoCitationSurface("youtube")).toBe(false);
    expect(getSurfaceProfile("reddit").outputKind).toBe("reddit-post");
    expect(() => getSurfaceProfile("blog")).toThrow(/Unsupported GEO citation surface/);
  });
});
