import type {
  GeoCitationRagDocument,
  RedditCitationArtifact,
  SupportedGeoCitationSurface
} from "../types";

export interface SurfaceProfile {
  surface: SupportedGeoCitationSurface;
  displayName: string;
  description: string;
  ragDocuments: GeoCitationRagDocument[];
  outputKind: "reddit-post";
  defaultFlair?: string;
  prohibitedPatterns: RegExp[];
}

export interface SurfaceValidationResult {
  artifact: RedditCitationArtifact;
  warnings: string[];
  promotionalToneScore: number;
}
