// Proves the routine-deploy path this workflow is materialized through
// (`apps/hub`'s `createHubRoutineLauncher` -> `@corbits/folded-runs`'
// `readFoldedBody` -> `launchFoldedRun`/`deployAtHead`) actually receives
// this definition's `toolPackagePins` off the same INERT PROJECTION a
// real deploy freezes onto the definition's version row. `readFoldedBody`
// is exercised directly over `projectLiveToInert` output (rather than
// standing up a database, a sidecar probe, and an asset service) because
// it is the one place in that path that reads `toolPackagePins` back out
// of the persisted projection — everywhere past it (`deployAtHead`,
// `sessionService`) only forwards the value it already carries, and is
// covered by `@corbits/folded-runs`' own tests.

import { expect, test } from "bun:test";
import { readFoldedBody } from "@corbits/folded-runs";
import { projectLiveToInert } from "@intx/workflow";

import {
  MORNING_BRIEF_STEP_ID,
  MORNING_BRIEF_TOOL_PACKAGE_PINS,
  buildMorningBriefWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "morning-brief@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120000,
} as const;

test("a workflow asset built from this definition surfaces its tool-package pins to the launch path", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  const projection: unknown = JSON.parse(
    JSON.stringify(projectLiveToInert(definition)),
  );
  const foldedBody = readFoldedBody(projection, definition.grantRequirements);
  expect(foldedBody.toolPackagePins).toEqual([
    ...MORNING_BRIEF_TOOL_PACKAGE_PINS,
  ]);
});

test("the folded body carries the step id this workflow declares as its single step", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(Object.keys(definition.steps)).toEqual([MORNING_BRIEF_STEP_ID]);
});
