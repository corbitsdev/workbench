// Proves CL-6051's reviewed boundary findings stay closed: the
// `{create}` branch can no longer bypass `@corbits/agent-directory`'s
// REST-boundary bounds (finding 1), and the planner's agent inventory
// filter excludes channel-host anchors (finding 4). Originally written
// to prove the bugs were OPEN (`tmp/critique-tests/planner-boundary.test.ts`);
// relocated here per this package's own `test/` convention for
// multi-module/composition suites (see `AGENTS.md`) with its first four
// assertions inverted to prove the bounds are now enforced.
import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  parseTaskSpec,
  validateTaskSpecAgainstInventory,
  spawnFromTaskSpec,
  PlannerCreateBoundsViolationError,
  type PlannerInventory,
  type SpawnDeps,
} from "@corbits/task-planner";
import { CreateAgentDefinitionInput } from "@corbits/agent-directory";
import { isAutomatableWorkflowName } from "@corbits/workflow-catalog";
import { isChannelHostDefinitionName } from "@corbits/chat";

const inventory: PlannerInventory = {
  agents: [{ id: "wfd_a", name: "a", displayName: "A" }],
  toolPackages: [
    {
      name: "@corbits/granola-tools",
      connectorId: "granola",
      credentialBinding: {
        package: "@corbits/granola-tools",
        handle: "granola",
        provider: "granola",
        locator: "tenant",
      },
    },
  ],
  skills: [{ name: "triage" }],
  memoryAvailable: false,
  models: [{ canonicalName: "m1" }],
};

/** A `SpawnDeps` whose every port fails the test loudly if called — a
 * bounds violation must be caught before any of them is ever reached. */
function neverCalledDeps(): SpawnDeps {
  return {
    taskLauncherDeps: {
      isTaskableDefinition: () => {
        throw new Error("launchTask should never be reached");
      },
    } as never,
    store: {
      linkPlannerRun: () => {
        throw new Error("store should never be reached");
      },
    } as never,
    deployAgentDefinition: () => {
      throw new Error("deployAgentDefinition should never be reached");
    },
    requireDefinitionCreateGrant: () => {
      throw new Error("requireDefinitionCreateGrant should never be reached");
    },
  };
}

const PLANNER_RUN_INPUT_BASE = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  plannerRunId: "wfr_planner_1",
  inventory,
};

describe("{create} branch no longer bypasses the REST boundary's bounds", () => {
  test("a 1MB systemPrompt is rejected, matching the REST route's own 8000-char cap", () => {
    const huge = "x".repeat(1_000_000);
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        create: { name: "n", systemPrompt: huge, toolPackagePins: [], skills: [] },
        refinedOutcome: "do it",
      }),
    );
    expect(() => validateTaskSpecAgainstInventory(spec, inventory)).not.toThrow();

    const rest = CreateAgentDefinitionInput({
      name: "n",
      handle: "n",
      systemPrompt: huge,
    });
    expect(rest instanceof type.errors).toBe(true);

    expect(
      spawnFromTaskSpec(neverCalledDeps(), {
        ...PLANNER_RUN_INPUT_BASE,
        spec,
      }),
    ).rejects.toBeInstanceOf(PlannerCreateBoundsViolationError);
  });

  test("a whitespace-only systemPrompt/name is rejected, matching the REST route's own non-blank bound", () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        create: { name: "   ", systemPrompt: "   ", toolPackagePins: [], skills: [] },
        refinedOutcome: "do it",
      }),
    );
    expect(() => validateTaskSpecAgainstInventory(spec, inventory)).not.toThrow();

    const rest = CreateAgentDefinitionInput({
      name: "   ",
      handle: "n",
      systemPrompt: "   ",
    });
    expect(rest instanceof type.errors).toBe(true);

    expect(
      spawnFromTaskSpec(neverCalledDeps(), {
        ...PLANNER_RUN_INPUT_BASE,
        spec,
      }),
    ).rejects.toBeInstanceOf(PlannerCreateBoundsViolationError);
  });

  test("duplicate skills are rejected, matching the REST route's own dedup bound", () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        create: {
          name: "n",
          systemPrompt: "p",
          toolPackagePins: [],
          skills: ["triage", "triage", "triage"],
        },
        refinedOutcome: "do it",
      }),
    );
    expect(() => validateTaskSpecAgainstInventory(spec, inventory)).not.toThrow();

    const rest = CreateAgentDefinitionInput({
      name: "n",
      handle: "n",
      systemPrompt: "p",
      skills: ["triage", "triage"],
    });
    expect(rest instanceof type.errors).toBe(true);

    expect(
      spawnFromTaskSpec(neverCalledDeps(), {
        ...PLANNER_RUN_INPUT_BASE,
        spec,
      }),
    ).rejects.toBeInstanceOf(PlannerCreateBoundsViolationError);
  });

  test("toolPackagePins now has a cardinality+dedup bound", () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        create: {
          name: "n",
          systemPrompt: "p",
          toolPackagePins: Array.from({ length: 10_000 }, () => "@corbits/granola-tools"),
          skills: [],
        },
        refinedOutcome: "do it",
      }),
    );
    // Out-of-scope for inventory validation (a repeated in-inventory name
    // isn't an out-of-inventory reference), so this still passes — the
    // cardinality/dedup bound is `spawnFromTaskSpec`'s own, proven below.
    expect(() => validateTaskSpecAgainstInventory(spec, inventory)).not.toThrow();

    expect(
      spawnFromTaskSpec(neverCalledDeps(), {
        ...PLANNER_RUN_INPUT_BASE,
        spec,
      }),
    ).rejects.toBeInstanceOf(PlannerCreateBoundsViolationError);
  });
});

describe("the planner's agent inventory filter excludes channel hosts", () => {
  test("a channel-host definition name is recognized by isChannelHostDefinitionName", () => {
    const hostName = `run-${"a".repeat(32)}`;
    expect(isChannelHostDefinitionName(hostName)).toBe(true);
    // apps/hub/src/index.ts's isConversationalAgentDefinition now excludes
    // this name too, alongside isAutomatableWorkflowName.
    expect(!isAutomatableWorkflowName(hostName)).toBe(true);
  });

  test("a channel host offered in the inventory still validates as a {use} target (validation is inventory-driven, not name-driven)", () => {
    const withHost: PlannerInventory = {
      ...inventory,
      agents: [{ id: "wfd_host", name: `run-${"a".repeat(32)}`, displayName: "host" }],
    };
    const spec = parseTaskSpec(
      JSON.stringify({ kind: "task", use: "wfd_host", refinedOutcome: "do it" }),
    );
    expect(() => validateTaskSpecAgainstInventory(spec, withHost)).not.toThrow();
  });
});
