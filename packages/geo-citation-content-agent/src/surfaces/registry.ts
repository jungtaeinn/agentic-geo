import { redditSurfaceProfile } from "./reddit/profile";
import type { SurfaceProfile } from "./types";
import type { GeoCitationSurface, SupportedGeoCitationSurface } from "../types";

const supportedSurfaces = {
  reddit: redditSurfaceProfile
} satisfies Record<SupportedGeoCitationSurface, SurfaceProfile>;

export function getSurfaceProfile(surface: GeoCitationSurface): SurfaceProfile {
  if (!isSupportedGeoCitationSurface(surface)) {
    throw new Error(`Unsupported GEO citation surface: ${surface}. Currently only reddit is implemented.`);
  }

  return supportedSurfaces[surface];
}

export function isSupportedGeoCitationSurface(surface: GeoCitationSurface): surface is SupportedGeoCitationSurface {
  return surface === "reddit";
}

export function listSupportedGeoCitationSurfaces(): SupportedGeoCitationSurface[] {
  return Object.keys(supportedSurfaces) as SupportedGeoCitationSurface[];
}
