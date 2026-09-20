import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("a narrow console keeps history in a bounded sidebar with its own scroll region", () => {
  assert.match(
    css,
    /@media \(max-width: 780px\)\s*\{[\s\S]*?\.codexSidebar\s*\{[\s\S]*?height:\s*min\(248px, 42dvh\);[\s\S]*?overflow:\s*hidden;/
  );
  assert.match(css, /\.historyList\s*\{[\s\S]*?overflow-y:\s*auto;/);
});

test("settings keeps close and actions reachable on a compact viewport", () => {
  assert.match(css, /\.settingsTopbar\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/);
  assert.match(css, /\.settingsTopbar button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(css, /\.settingsActions\s*\{[\s\S]*?bottom:\s*0;/);
  assert.doesNotMatch(css, /bottom:\s*-40px/);
  assert.match(css, /\.settingsActions button\s*\{[\s\S]*?min-height:\s*44px;/);
  assert.match(
    css,
    /@media \(max-width: 1079px\)\s*\{[\s\S]*?\.settingsModal\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/
  );
});
