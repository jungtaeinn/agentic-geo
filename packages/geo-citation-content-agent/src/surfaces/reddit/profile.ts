import type { SurfaceProfile } from "../types";

export const redditSurfaceProfile: SurfaceProfile = {
  surface: "reddit",
  displayName: "Reddit",
  description: "Question-led, evidence-backed Reddit discussion artifact for citation-ready GEO content.",
  outputKind: "reddit-post",
  defaultFlair: "Discussion",
  ragDocuments: [
    {
      name: "reddit-content-guidelines_v1.md",
      version: "v1",
      sourceRole: "surface-guideline",
      surface: "reddit",
      content: ""
    },
    {
      name: "reddit-post-patterns_v1.md",
      version: "v1",
      sourceRole: "surface-guideline",
      surface: "reddit",
      content: ""
    }
  ],
  prohibitedPatterns: [
    /\bbuy now\b/i,
    /\bshop now\b/i,
    /\blink in bio\b/i,
    /\blimited offer\b/i,
    /지금\s*구매/i,
    /바로\s*구매/i,
    /링크를\s*확인/i
  ]
};
