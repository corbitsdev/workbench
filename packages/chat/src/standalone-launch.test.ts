// CL-6367: the mapping row a standalone (routine/webhook) launch
// commits with its run is what makes that run relaunchable at all —
// the terminal sweep and the wake path both resolve through it.
import { describe, expect, test } from "bun:test";

import { workbenchLaunch } from "./schema";
import {
  AGENT_SECTION_MODE,
  workbenchLaunchPersistExtra,
} from "./standalone-launch";
import { CHAT_TURN_TIMEOUT_MS } from "./turn-claims";

const FOLDED_BODY = {
  systemPrompt: "be helpful",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

describe("AGENT_SECTION_MODE", () => {
  test("is the onTrigger section shape with the chat turn timeout", () => {
    expect(AGENT_SECTION_MODE).toEqual({
      kind: "section",
      turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    });
  });
});

describe("workbenchLaunchPersistExtra", () => {
  test("writes the identity mapping into workbench_launch", async () => {
    const written: { table: unknown; values: unknown }[] = [];
    const tx = {
      insert: (table: unknown) => ({
        values: async (values: unknown) => {
          written.push({ table, values });
        },
      }),
    };

    await workbenchLaunchPersistExtra({
      tenantId: "ten_1",
      instanceId: "wfr_standalone1",
      foldedBody: FOLDED_BODY,
    })(tx as never);

    expect(written).toHaveLength(1);
    expect(written[0]?.table).toBe(workbenchLaunch);
    expect(written[0]?.values).toMatchObject({
      tenantId: "ten_1",
      instanceId: "wfr_standalone1",
      // Identity mapping at birth; every relaunch re-points
      // `currentRunId` while the stable id never moves.
      currentRunId: "wfr_standalone1",
      foldedBody: FOLDED_BODY,
      // Never a workbench host: a standalone launch's replies are real,
      // so every wake/relaunch resolves the tenant catalog.
      noopInference: false,
    });
  });
});
