import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("1024, 860, and 800 use a dismissible progress overlay instead of reserving a desktop rail", () => {
  assert.match(css, /:root\s*\{[\s\S]*?--status-reserve:\s*0px;/);
  assert.match(css, /@media \(min-width: 1152px\)\s*\{[\s\S]*?\.codexShell\s*\{[\s\S]*?--status-reserve:\s*calc\(var\(--status-panel-width\)/);
  assert.match(css, /@media \(min-width: 781px\) and \(max-width: 1151px\)\s*\{[\s\S]*?\.statusPanel\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(css, /@media \(min-width: 781px\) and \(max-width: 1151px\)[\s\S]*?\.progressCloseButton\s*\{[\s\S]*?display:\s*grid;/);
});

test("settings becomes a single-column, persistent-control dialog below 1080px including 375 by 667", () => {
  assert.match(css, /\.settingsContent\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.settingsScroll\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.settingsActions\s*\{[\s\S]*?padding:\s*14px min\(72px, 6vw\);/);
  assert.doesNotMatch(css, /bottom:\s*-40px/);
  assert.match(css, /@media \(max-width: 1079px\)\s*\{[\s\S]*?\.settingsModal\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /height:\s*min\(760px, calc\(100dvh - 32px\)\);/);
  assert.match(css, /\.settingsTopbar button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(css, /\.settingsActions button\s*\{[\s\S]*?min-height:\s*44px;/);
});

test("reference metadata stays readable instead of compressing to four columns on a narrow screen", () => {
  assert.match(
    css,
    /@media \(max-width: 480px\)\s*\{[\s\S]*?\.ragReferenceMeta\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/
  );
});

test("a narrow console gives history a bounded sidebar and its own scroll region", () => {
  assert.match(
    css,
    /@media \(max-width: 780px\)\s*\{[\s\S]*?\.codexSidebar\s*\{[\s\S]*?height:\s*min\(248px, 42dvh\);[\s\S]*?overflow:\s*hidden;/
  );
  assert.match(css, /\.historyList\s*\{[\s\S]*?overflow-y:\s*auto;/);
});
