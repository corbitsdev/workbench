import { describe, expect, test } from "bun:test";

import {
  isAutomatableWorkflowName,
  workflowDisplayName,
  WORKFLOW_CATALOG,
} from "../src/index";

describe("workflow catalog", () => {
  test("marks channel-digest, heartbeat, and morning-brief automatable, not echo or assistant", () => {
    expect(isAutomatableWorkflowName("channel-digest")).toBe(true);
    expect(isAutomatableWorkflowName("heartbeat")).toBe(true);
    expect(isAutomatableWorkflowName("morning-brief")).toBe(true);
    expect(isAutomatableWorkflowName("echo")).toBe(false);
    expect(isAutomatableWorkflowName("assistant")).toBe(false);
  });

  test("marks the granola-call parent automatable, not its process-granola-call child", () => {
    // The parent is schedule-attachable; the child is spawned per call and
    // must never appear as an independent Routines-picker option.
    expect(isAutomatableWorkflowName("granola-call")).toBe(true);
    expect(isAutomatableWorkflowName("process-granola-call")).toBe(false);
  });

  test("prefers the catalog display name for the granola-call workflows", () => {
    expect(workflowDisplayName("granola-call")).toBe("Granola call notes");
    expect(workflowDisplayName("process-granola-call")).toBe(
      "Process Granola call",
    );
  });

  test("rejects agent handles and channel-host names as automatable", () => {
    expect(isAutomatableWorkflowName("my-researcher")).toBe(false);
    expect(isAutomatableWorkflowName("channel-host-abc")).toBe(false);
    expect(isAutomatableWorkflowName("wfd_deadbeef")).toBe(false);
  });

  test("prefers catalog display names over raw asset names", () => {
    expect(workflowDisplayName("channel-digest")).toBe("Channel digest");
    expect(workflowDisplayName("heartbeat")).toBe("Heartbeat");
    expect(workflowDisplayName("morning-brief")).toBe("Morning brief");
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
    expect(workflowDisplayName("unknown-flow", "  Weekly brief  ")).toBe(
      "Weekly brief",
    );
    expect(workflowDisplayName("last-30-days")).toBe("Last 30 Days");
  });

  test("every catalog entry has a non-empty display name", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.assetName).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
