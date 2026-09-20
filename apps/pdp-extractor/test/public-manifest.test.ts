import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the Extractor public manifest resolves start and icon URLs beneath the Pages base path and at an origin root", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")) as {
    start_url: string;
    icons: Array<{ src: string }>;
  };

  assertManifestUrls(manifest, "https://pages.example/agentic-geo/manifest.webmanifest", "https://pages.example/agentic-geo/");
  assertManifestUrls(manifest, "https://console.example/manifest.webmanifest", "https://console.example/");
});

function assertManifestUrls(
  manifest: { start_url: string; icons: Array<{ src: string }> },
  manifestUrl: string,
  expectedStartUrl: string
): void {
  assert.equal(new URL(manifest.start_url, manifestUrl).href, expectedStartUrl);
  assert.deepEqual(manifest.icons.map(({ src }) => new URL(src, manifestUrl).pathname), [
    new URL("icons/profile-rounded-48.png", manifestUrl).pathname,
    new URL("icons/profile-rounded-192.png", manifestUrl).pathname,
    new URL("icons/profile-rounded-512.png", manifestUrl).pathname,
    new URL("icons/profile-rounded-512.png", manifestUrl).pathname
  ]);
}
