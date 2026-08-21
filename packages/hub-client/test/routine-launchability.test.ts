// CL-6495: last-30-days-research shipped as a six-step
// `@intx/workflow` definition, but every routine "run now" (and every
// scheduled fire) launches through `@corbits/folded-runs`'
// `readFoldedBody` (via `apps/hub/src/routine-launcher.ts`), which has
// always required exactly one step — it throws synchronously,
// uncaught, turning into a bare 500 on the very first launch attempt.
// Nothing caught this at seed time or in CI because no test ever
// exercised "does this deployed definition actually satisfy the
// launcher's shape," only that it deployed and serialized correctly.
//
// This guards the whole class, not just this one workflow: every
// entry in `DEFAULT_WORKFLOWS` is deployed to every real tenant and is
// reachable from a routine (either directly, via
// `DEFAULT_ROUTINE_PRESETS`, or by a member hand-creating one against
// any deployed definition), so every entry must produce a genuinely
// single-step definition — the one shape this repo's launcher can run.
import { expect, test } from "bun:test";

import { DEFAULT_WORKFLOWS, type ModelSource } from "../src/seed";

const FAKE_MODEL: ModelSource = {
  provider: "ollama",
  model: "qwen-test",
  baseURL: "http://localhost:11434",
  apiKey: "test-key",
};

type SerializedStepDefinition = {
  readonly stepOrder: readonly string[];
  readonly steps: Readonly<Record<string, unknown>>;
};

test("every default workflow's deployed definition is single-step — the only shape the routine launcher can run", () => {
  for (const workflow of DEFAULT_WORKFLOWS) {
    const json = workflow.buildJson("example.test", FAKE_MODEL);
    const definition = JSON.parse(json) as SerializedStepDefinition;
    expect(
      definition.stepOrder.length,
      `"${workflow.assetName}" deploys a ${definition.stepOrder.length}-step ` +
        "definition; @corbits/folded-runs' readFoldedBody (every routine " +
        "run) throws for anything but exactly one step",
    ).toBe(1);
    expect(Object.keys(definition.steps)).toEqual([...definition.stepOrder]);
  }
});
