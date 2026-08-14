import { describe, expect, test } from "bun:test";

import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";

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

  test("does not mark pain-point-collateral automatable — its approval gate is a poor fit for unattended scheduling", () => {
    expect(isAutomatableWorkflowName("pain-point-collateral")).toBe(false);
    expect(workflowDisplayName("pain-point-collateral")).toBe(
      "Pain-point collateral",
    );
  });

  test("does not mark collateral-generation automatable — on-demand only, gated behind its final approval", () => {
    expect(isAutomatableWorkflowName("collateral-generation")).toBe(false);
    expect(workflowDisplayName("collateral-generation")).toBe(
      "Collateral generation",
    );
  });

  test("marks reddit-opportunity-scanner on-demand — its approval gates make it a poor unattended fit", () => {
    expect(isAutomatableWorkflowName("reddit-opportunity-scanner")).toBe(false);
    expect(workflowDisplayName("reddit-opportunity-scanner")).toBe(
      "Reddit opportunity scanner",
    );
  });

  test("does not mark last-30-days-research automatable — on-demand only, gated behind a human-supplied topic per run", () => {
    expect(isAutomatableWorkflowName("last-30-days-research")).toBe(false);
    expect(workflowDisplayName("last-30-days-research")).toBe(
      "Last 30 days research report",
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
      expect(entry.exampleOutput[0]).toBe(
        entry.exampleOutput[0]?.toUpperCase(),
      );
    }
  });

  test("every requiredConnections id names a real connector in the registry", () => {
    const knownConnectorIds = new Set(Object.keys(CONNECTOR_REGISTRY));
    for (const entry of WORKFLOW_CATALOG) {
      for (const connectorId of entry.requiredConnections) {
        expect(knownConnectorIds.has(connectorId)).toBe(true);
      }
    }
  });

  test("pins the GTM ports to the connectors their tool packages actually need", () => {
    const byAssetName = new Map(
      WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
    );
    expect(byAssetName.get("granola-call")?.requiredConnections).toEqual([
      "granola",
    ]);
    expect(
      byAssetName.get("process-granola-call")?.requiredConnections,
    ).toEqual(["granola"]);
    expect(byAssetName.get("morning-brief")?.requiredConnections).toEqual([
      "granola",
      "linear",
    ]);
    expect(
      byAssetName.get("pain-point-collateral")?.requiredConnections,
    ).toEqual(["granola"]);
    expect(
      byAssetName.get("collateral-generation")?.requiredConnections,
    ).toEqual(["granola", "linear"]);
    expect(
      byAssetName.get("reddit-opportunity-scanner")?.requiredConnections,
    ).toEqual(["scrapecreators"]);
    expect(
      byAssetName.get("last-30-days-research")?.requiredConnections,
    ).toEqual(["exa"]);
  });

  test("workflows with no external connector requirement declare an empty list", () => {
    const byAssetName = new Map(
      WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
    );
    expect(byAssetName.get("echo")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("assistant")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("heartbeat")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("channel-digest")?.requiredConnections).toEqual([]);
  });
});
