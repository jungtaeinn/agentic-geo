import { geoCitationContentRagManifest } from "./manifest";
import type { GeoCitationRagDocument, GeoCitationSurface } from "../types";

export interface GeoCitationRagIndexEntry {
  document: string;
  version: string;
  sourceRole: NonNullable<GeoCitationRagDocument["sourceRole"]>;
  mandatory: boolean;
  surface?: GeoCitationSurface;
  checkedAt: string;
  intents: Array<"citation-contract" | "eeat" | "cep" | "claim-safety" | "surface-tone" | "answer-chunk" | "evidence">;
  priority: number;
}

export const geoCitationRagIndex: GeoCitationRagIndexEntry[] = [
  {
    document: geoCitationContentRagManifest.mandatory.citationReadyContentContract,
    version: "v1",
    sourceRole: "mandatory-policy",
    mandatory: true,
    checkedAt: "2026-07-01",
    intents: ["citation-contract", "answer-chunk", "claim-safety", "surface-tone"],
    priority: 1
  },
  {
    document: geoCitationContentRagManifest.mandatory.geoCitationReadiness,
    version: "v1",
    sourceRole: "mandatory-policy",
    mandatory: true,
    checkedAt: "2026-07-01",
    intents: ["answer-chunk", "evidence"],
    priority: 0.94
  },
  {
    document: geoCitationContentRagManifest.mandatory.eeat,
    version: "v1",
    sourceRole: "mandatory-policy",
    mandatory: true,
    checkedAt: "2026-07-01",
    intents: ["eeat", "evidence", "claim-safety"],
    priority: 0.92
  },
  {
    document: geoCitationContentRagManifest.mandatory.cep,
    version: "v1",
    sourceRole: "mandatory-policy",
    mandatory: true,
    checkedAt: "2026-07-01",
    intents: ["cep", "answer-chunk"],
    priority: 0.88
  },
  {
    document: geoCitationContentRagManifest.mandatory.claimSafety,
    version: "v1",
    sourceRole: "mandatory-policy",
    mandatory: true,
    checkedAt: "2026-07-01",
    intents: ["claim-safety", "evidence"],
    priority: 0.96
  },
  {
    document: geoCitationContentRagManifest.surfaces.reddit.contentGuidelines,
    version: "v1",
    sourceRole: "surface-guideline",
    mandatory: false,
    surface: "reddit",
    checkedAt: "2026-07-01",
    intents: ["surface-tone", "answer-chunk"],
    priority: 0.9
  },
  {
    document: geoCitationContentRagManifest.surfaces.reddit.postPatterns,
    version: "v1",
    sourceRole: "surface-guideline",
    mandatory: false,
    surface: "reddit",
    checkedAt: "2026-07-01",
    intents: ["surface-tone", "answer-chunk"],
    priority: 0.84
  }
];
