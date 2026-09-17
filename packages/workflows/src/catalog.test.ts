import { type } from "arktype";
import { describe, expect, test } from "bun:test";

import {
  deliveryWorkbenchRequiredForWorkflowName,
  isAutomatableWorkflowName,
  isConversationalWorkflowName,
  validateTriggerFieldsAtCreate,
  workflowDisplayName,
  workflowCatalogEntry,
  WorkflowTriggerField,
  WORKFLOW_CATALOG,
} from "./catalog";

describe("workflow catalog", () => {
  test("marks neither echo nor assistant automatable", () => {
    expect(isAutomatableWorkflowName("echo")).toBe(false);
    expect(isAutomatableWorkflowName("assistant")).toBe(false);
  });

  test("rejects agent handles and workbench-host names as automatable", () => {
    expect(isAutomatableWorkflowName("my-researcher")).toBe(false);
    expect(isAutomatableWorkflowName("workbench-host-abc")).toBe(false);
    expect(isAutomatableWorkflowName("wfd_deadbeef")).toBe(false);
  });

  test("prefers catalog display names over raw asset names", () => {
    expect(workflowDisplayName("echo")).toBe("Echo");
    expect(workflowDisplayName("assistant")).toBe("Myra");
  });

  test("productizes the seeded assistant under the Myra display name", () => {
    // The assistant workflow ships in DEFAULT_WORKFLOWS for every personal
    // bench. Its catalog display name is the productized label Myra, not
    // the generic "Assistant" — the routines picker and seeded asset both
    // read it from here.
    expect(workflowDisplayName("assistant")).toBe("Myra");
    const entry = WORKFLOW_CATALOG.find((e) => e.assetName === "assistant");
    expect(entry?.displayName).toBe("Myra");
  });

  test("falls back to description, then humanized name — never blank", () => {
    expect(workflowDisplayName("unknown-flow", "  Weekly brief  ")).toBe("Weekly brief");
    expect(workflowDisplayName("last-30-days")).toBe("Last 30 Days");
  });

  describe("isConversationalWorkflowName", () => {
    test("marks only the seeded assistant/Myra definition conversational", () => {
      expect(isConversationalWorkflowName("assistant")).toBe(true);
    });

    test("marks echo, the mail-triggered wiring check, non-conversational", () => {
      expect(isConversationalWorkflowName("echo")).toBe(false);
    });

    test("treats a name absent from the catalog as conversational — a runtime agent-directory definition", () => {
      expect(isConversationalWorkflowName("my-researcher")).toBe(true);
      expect(isConversationalWorkflowName("wfd_deadbeef")).toBe(true);
    });

    // CL-6649: a non-automatable utility (echo) is still non-conversational
    // — the exact combination that let a picker gated on
    // `!isAutomatableWorkflowName` alone (rather than
    // `isConversationalWorkflowName`) mistake a routine's delivery
    // workflow for an invitable chat agent.
    test("a non-automatable utility is still non-conversational (the CL-6649 trap)", () => {
      expect(isAutomatableWorkflowName("echo")).toBe(false);
      expect(isConversationalWorkflowName("echo")).toBe(false);
    });

    test("every catalog entry declares a conversational flag", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(typeof entry.conversational).toBe("boolean");
      }
    });
  });

  test("every catalog entry has a non-empty display name", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.assetName).toMatch(/^[a-z0-9-]+$/);
    }
  });

  describe("deliveryMode", () => {
    test("every catalog entry declares a delivery mode", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(["workbench", "inbox"]).toContain(entry.deliveryMode);
      }
    });

    test("no catalog entry currently delivers to inbox", () => {
      const inboxEntries = WORKFLOW_CATALOG.filter((entry) => entry.deliveryMode === "inbox");
      expect(inboxEntries).toEqual([]);
    });

    test("deliveryWorkbenchRequiredForWorkflowName is true for every known catalog entry", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(deliveryWorkbenchRequiredForWorkflowName(entry.assetName)).toBe(true);
      }
    });

    test("an unknown workflow name defaults to workbench-required", () => {
      expect(deliveryWorkbenchRequiredForWorkflowName("unknown-workflow")).toBe(true);
    });
  });

  test("every catalog entry carries honest demo-card copy", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.whatItDoes.trim().length).toBeGreaterThan(0);
      expect(entry.exampleOutput.trim().length).toBeGreaterThan(0);
      expect(entry.typicalDuration.trim().length).toBeGreaterThan(0);
      // No fake precision or invented metrics dressed up as facts.
      expect(entry.whatItDoes).not.toMatch(/%|\$\d/);
    }
  });

  test("every exampleOutput is a single capitalized readout fragment with no trailing period", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.exampleOutput).not.toContain("\n");
      expect(entry.exampleOutput.endsWith(".")).toBe(false);
      expect(entry.exampleOutput[0]).toBe(entry.exampleOutput[0]?.toUpperCase());
    }
  });

  test("workflows with no external connector requirement declare an empty list", () => {
    const byAssetName = new Map(WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]));
    expect(byAssetName.get("echo")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("assistant")?.requiredConnections).toEqual([]);
  });

  describe("triggerFields", () => {
    test("every declared triggerFields entry matches the WorkflowTriggerField shape", () => {
      for (const entry of WORKFLOW_CATALOG) {
        if (entry.triggerFields === undefined) continue;
        const parsed = WorkflowTriggerField.array()(entry.triggerFields);
        expect(parsed instanceof type.errors).toBe(false);
      }
    });

    test("every triggerFields key is unique within its entry and non-blank labeled", () => {
      for (const entry of WORKFLOW_CATALOG) {
        if (entry.triggerFields === undefined) continue;
        const keys = entry.triggerFields.map((field) => field.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const field of entry.triggerFields) {
          expect(field.label.trim().length).toBeGreaterThan(0);
        }
      }
    });

    test("echo and assistant take no human-supplied trigger content", () => {
      expect(workflowCatalogEntry("echo")?.triggerFields).toBeUndefined();
      expect(workflowCatalogEntry("assistant")?.triggerFields).toBeUndefined();
    });
  });

  // Two required fields, one "agent"-kind and one "text"-kind — an
  // explicit local fixture, not pulled from any catalog entry, so this
  // block's assertions about required/blank/non-string handling stay
  // meaningful regardless of which entries the catalog happens to carry.
  const AGENT_AND_PROMPT_FIELDS: readonly WorkflowTriggerField[] = [
    { key: "agent", kind: "agent", label: "Agent", required: true },
    { key: "prompt", kind: "text", label: "Prompt", required: true },
  ];

  // CL-6358: inputs bind at USE, never at creation — a scheduled
  // definition (or a seed preset) must be creatable with a required
  // trigger field left entirely unbound. `validateTriggerFieldsAtCreate`
  // is the boundary check the schedule create path applies now:
  // absence of a required field is never rejected, only a value the
  // caller explicitly provided but left malformed is.
  describe("validateTriggerFieldsAtCreate", () => {
    const fields = AGENT_AND_PROMPT_FIELDS;

    test("a required field left entirely unbound passes at create time", () => {
      expect(validateTriggerFieldsAtCreate(fields, { prompt: "Do it" })).toEqual({ ok: true });
    });

    test("a provided-but-blank required field still fails: a caller who sets it must set it honestly", () => {
      const result = validateTriggerFieldsAtCreate(fields, {
        agent: "   ",
        prompt: "Do it",
      });
      expect(result.ok).toBe(false);
    });

    test("a provided non-string value for a required field still fails", () => {
      const result = validateTriggerFieldsAtCreate(fields, {
        agent: 12345,
        prompt: "Do it",
      });
      expect(result.ok).toBe(false);
    });

    test("a fully valid input still passes", () => {
      expect(
        validateTriggerFieldsAtCreate(fields, {
          agent: "wfd_1",
          prompt: "Do it",
        }),
      ).toEqual({ ok: true });
    });
  });
});
