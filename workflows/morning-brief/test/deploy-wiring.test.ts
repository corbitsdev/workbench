// Proves the routine-deploy path this workflow is materialized through
// (`apps/hub`'s `createHubRoutineLauncher` -> `@corbits/folded-runs`'
// `readFoldedBody` -> `launchFoldedRun`/`deployAtHead`) actually receives
// this definition's `toolPackagePins` off the same JSON a real deploy
// writes into a workflow asset. `readFoldedBody` is exercised directly
// (rather than standing up a database and an asset service) because it
// is the one place in that path that reads `toolPackagePins` back out of
// parsed JSON — everywhere past it (`deployAtHead`, `sessionService`)
// only forwards the value it already carries, and is covered by
// `@corbits/folded-runs`' own tests.

import { expect, test } from "bun:test";
import { readFoldedBody } from "@corbits/folded-runs";

import {
  MORNING_BRIEF_STEP_ID,
  MORNING_BRIEF_TOOL_PACKAGE_PINS,
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "morning-brief@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120000,
} as const;

test("a workflow asset built from this definition surfaces its tool-package pins to the launch path", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  const assetJSON: unknown = JSON.parse(
    serializeMorningBriefWorkflow(definition),
  );
  const foldedBody = readFoldedBody(assetJSON);
  expect(foldedBody.toolPackagePins).toEqual([
    ...MORNING_BRIEF_TOOL_PACKAGE_PINS,
  ]);
});

test("the folded body carries the step id this workflow declares as its single step", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(Object.keys(definition.steps)).toEqual([MORNING_BRIEF_STEP_ID]);
});
