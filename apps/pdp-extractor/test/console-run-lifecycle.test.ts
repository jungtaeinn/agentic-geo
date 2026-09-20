import assert from "node:assert/strict";
import test from "node:test";

import { createExtractorRunEpochGate } from "../src/app/components/ExtractorConsole";

test("starting a new chat invalidates an in-flight extraction before its completion can update the cleared view", () => {
  const gate = createExtractorRunEpochGate();
  const inFlightRun = gate.begin();

  assert.equal(gate.isCurrent(inFlightRun), true);

  gate.invalidate();

  assert.equal(gate.isCurrent(inFlightRun), false);
  const replacementRun = gate.begin();
  assert.equal(gate.isCurrent(replacementRun), true);
  assert.equal(gate.isCurrent(inFlightRun), false);
});
