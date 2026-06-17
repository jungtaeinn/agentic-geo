import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Agentic GEO Generator",
    short_name: "GEO Generator",
    description: "PDP extraction and GEO-ready schema/content generation console.",
    start_url: "/",
    display: "standalone",
    background_color: "#111312",
    theme_color: "#111312",
    icons: [
      {
        src: "/icons/profile-rounded-48.png",
        sizes: "48x48",
        type: "image/png"
      },
      {
        src: "/icons/profile-rounded-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icons/profile-rounded-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icons/profile-rounded-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
