export const geoCitationContentRagManifest = {
  profile: "geo-citation-content-default",
  mandatory: {
    citationReadyContentContract: "citation-ready-content-contract_v1.md",
    geoCitationReadiness: "geo-citation-readiness_v1.md",
    eeat: "eeat_v1.md",
    cep: "cep_v1.md",
    claimSafety: "claim-safety_v1.md"
  },
  surfaces: {
    reddit: {
      contentGuidelines: "reddit-content-guidelines_v1.md",
      postPatterns: "reddit-post-patterns_v1.md"
    }
  }
} as const;
