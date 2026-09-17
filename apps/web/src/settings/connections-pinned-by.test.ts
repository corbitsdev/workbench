import { describe, expect, test } from "bun:test";

import { WORKFLOW_CATALOG } from "@corbits/workflows/catalog";

import { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";

describe("connections pinned-by", () => {
  test("pins every workflow-catalog entry to the same connectors its own requiredConnections list names", () => {
    const pinnedAssetNamesByConnector = new Map(
      Object.entries(CONNECTOR_PINNED_WORKFLOWS).map(([connectorId, assetNames]) => [
        connectorId,
        new Set(assetNames),
      ]),
    );
    for (const entry of WORKFLOW_CATALOG) {
      for (const connectorId of entry.requiredConnections) {
        const pinned = pinnedAssetNamesByConnector.get(connectorId);
        expect(pinned?.has(entry.assetName)).toBe(true);
      }
    }
  });

  test("manus pins the assistant", () => {
    expect(CONNECTOR_PINNED_WORKFLOWS.manus).toEqual(["assistant"]);
  });
});
