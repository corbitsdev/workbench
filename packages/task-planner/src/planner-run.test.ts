import { describe, expect, test } from "bun:test";

import {
  runPlanner,
  PlannerInferenceUnavailableError,
  PlannerMyraUnavailableError,
  type PlannerRunDeps,
} from "./planner-run";
import type { InventorySources } from "./inventory";
import {
  PlannerReferenceOutOfInventoryError,
  PlannerReplyUnparseableError,
} from "./task-spec";
import { FoldedRunTimedOutError } from "@corbits/folded-run-one-shot";

const INVENTORY_SOURCES: InventorySources = {
  async listConversationalAgents() {
    return [
      { id: "wfd_summarizer", name: "summarizer", displayName: "Summarizer" },
    ];
  },
  async listUsableToolPackages() {
    return [
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
    ];
  },
  async listSkills() {
    return [{ name: "incident-review" }];
  },
  memoryAvailable: false,
  async listModels() {
    return [{ canonicalName: "anthropic/claude-sonnet-5" }];
  },
};

function buildDeps(overrides: Partial<PlannerRunDeps> = {}): PlannerRunDeps {
  return {
    db: {} as never,
    runner: {
      run: async () => ({
        content: JSON.stringify({
          kind: "task",
          use: "wfd_summarizer",
          refinedOutcome: "Summarize the doc",
        }),
        runId: "wfr_planner_1",
      }),
    },
    inventorySources: INVENTORY_SOURCES,
    resolveMyraDefinitionId: async () => "wfd_myra",
    ...overrides,
  };
}

const INPUT = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  outcome: "Summarize the doc",
};

describe("runPlanner", () => {
  test("a valid in-inventory {use} reply succeeds", async () => {
    const result = await runPlanner(buildDeps(), INPUT);
    expect(result.spec).toEqual({
      kind: "task",
      use: "wfd_summarizer",
      refinedOutcome: "Summarize the doc",
    });
    expect(result.plannerRunId).toBe("wfr_planner_1");
    expect(result.inventory.agents).toHaveLength(1);
  });

  test("a valid in-inventory {create} reply succeeds", async () => {
    const deps = buildDeps({
      runner: {
        run: async () => ({
          content: JSON.stringify({
            kind: "task",
            create: {
              name: "Incident bot",
              systemPrompt: "You review incidents.",
              toolPackagePins: ["@corbits/granola-tools"],
              skills: ["incident-review"],
              modelPreference: "anthropic/claude-sonnet-5",
            },
            refinedOutcome: "Review the latest incident",
          }),
          runId: "wfr_planner_2",
        }),
      },
    });
    const result = await runPlanner(deps, INPUT);
    expect("create" in result.spec).toBe(true);
  });

  test("an out-of-inventory reference fails closed", async () => {
    const deps = buildDeps({
      runner: {
        run: async () => ({
          content: JSON.stringify({
            kind: "task",
            use: "wfd_unknown",
            refinedOutcome: "Summarize the doc",
          }),
          runId: "wfr_planner_3",
        }),
      },
    });
    await expect(runPlanner(deps, INPUT)).rejects.toBeInstanceOf(
      PlannerReferenceOutOfInventoryError,
    );
  });

  test("a malformed JSON reply fails closed", async () => {
    const deps = buildDeps({
      runner: { run: async () => ({ content: "not json", runId: "wfr_4" }) },
    });
    await expect(runPlanner(deps, INPUT)).rejects.toBeInstanceOf(
      PlannerReplyUnparseableError,
    );
  });

  test("a runner failure (timeout/failed run) propagates unchanged", async () => {
    const deps = buildDeps({
      runner: {
        run: async () => {
          throw new FoldedRunTimedOutError(60_000);
        },
      },
    });
    await expect(runPlanner(deps, INPUT)).rejects.toBeInstanceOf(
      FoldedRunTimedOutError,
    );
  });

  test("an unresolvable Myra definition throws PlannerMyraUnavailableError", async () => {
    const deps = buildDeps({
      resolveMyraDefinitionId: async () => {
        throw new PlannerMyraUnavailableError("tnt_1", "no deployed Myra");
      },
    });
    await expect(runPlanner(deps, INPUT)).rejects.toBeInstanceOf(
      PlannerMyraUnavailableError,
    );
  });

  const INFERENCE_FAILURE_REPLY =
    "This agent could not complete your request due to an unrecoverable inference error [HTTP 500]: upstream saturated";

  test("an inference-failure reply retries once, then succeeds", async () => {
    let calls = 0;
    const deps = buildDeps({
      inferenceRetryDelayMs: 0,
      runner: {
        run: async () => {
          calls += 1;
          if (calls === 1) {
            return { content: INFERENCE_FAILURE_REPLY, runId: "wfr_5a" };
          }
          return {
            content: JSON.stringify({
              kind: "task",
              use: "wfd_summarizer",
              refinedOutcome: "Summarize the doc",
            }),
            runId: "wfr_5b",
          };
        },
      },
    });
    const result = await runPlanner(deps, INPUT);
    expect(calls).toBe(2);
    expect(result.plannerRunId).toBe("wfr_5b");
  });

  test("an inference-failure reply on both attempts throws PlannerInferenceUnavailableError, not planning_failed", async () => {
    let calls = 0;
    const deps = buildDeps({
      inferenceRetryDelayMs: 0,
      runner: {
        run: async () => {
          calls += 1;
          return { content: INFERENCE_FAILURE_REPLY, runId: `wfr_6_${calls}` };
        },
      },
    });
    await expect(runPlanner(deps, INPUT)).rejects.toBeInstanceOf(
      PlannerInferenceUnavailableError,
    );
    expect(calls).toBe(2);
  });
});
