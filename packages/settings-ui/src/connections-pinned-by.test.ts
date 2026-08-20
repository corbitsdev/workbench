import { describe, expect, test } from "bun:test";

import { WORKFLOW_CATALOG } from "@corbits/workflow-catalog";

import { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";

describe("connections pinned-by", () => {
  test("pins every workflow-catalog entry to the same connectors its own requiredConnections list names", () => {
    const pinnedAssetNamesByConnector = new Map(
      Object.entries(CONNECTOR_PINNED_WORKFLOWS).map(
        ([connectorId, assetNames]) => [connectorId, new Set(assetNames)],
      ),
    );
    for (const entry of WORKFLOW_CATALOG) {
      for (const connectorId of entry.requiredConnections) {
        const pinned = pinnedAssetNamesByConnector.get(connectorId);
        expect(pinned?.has(entry.assetName)).toBe(true);
      }
    }
  });

  test("granola pins every Granola-backed GTM workflow, not just the call-notes pair", () => {
    expect(CONNECTOR_PINNED_WORKFLOWS.granola).toEqual(
      expect.arrayContaining([
        "granola-call",
        "process-granola-call",
        "morning-brief",
        "pain-point-collateral",
        "collateral-generation",
      ]),
    );
  });

  test("linear pins morning-brief and collateral-generation", () => {
    expect(CONNECTOR_PINNED_WORKFLOWS.linear).toEqual(
      expect.arrayContaining(["morning-brief", "collateral-generation"]),
    );
  });

  test("exa pins last-30-days-research", () => {
    expect(CONNECTOR_PINNED_WORKFLOWS.exa).toEqual(["last-30-days-research"]);
  });

  test("scrapecreators pins reddit-opportunity-scanner", () => {
    expect(CONNECTOR_PINNED_WORKFLOWS.scrapecreators).toEqual([
      "reddit-opportunity-scanner",
    ]);
  });
});
