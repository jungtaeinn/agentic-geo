import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic GEO Generator",
  description: "PDP extraction and GEO-ready schema/content generation console.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/profile-rounded-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/profile-rounded-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/profile-rounded-192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
    ],
    shortcut: ["/icons/profile-rounded-32.png"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
