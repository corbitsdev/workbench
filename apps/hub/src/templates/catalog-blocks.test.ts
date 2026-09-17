// Pins the hub's native catalog-block adapter (`./catalog-blocks`): the
// deployable set served by `POST /template-blocks/:assetName/deploy`,
// rendered from the `workflows/*` builder packages against
// `@corbits/workflows` catalog metadata — with zero import from
// `@workbench/onboarding`.
//
// ANTI-DRIFT PIN: the adapter's asset names are exactly the native
// `WORKFLOW_CATALOG` names minus `assistant` (seeded already, never
// redeployed here) and `heartbeat` (test-only, never deployed onto a
// real bench). A workflow added to the catalog without a builder entry
// here — or a builder entry with no catalog backing — fails this test,
// so the deployable set and the served sources cannot drift apart
// silently.
import { describe, expect, test } from "bun:test";
import { WORKFLOW_CATALOG } from "@corbits/workflows";

import {
  CATALOG_BLOCK_ASSET_NAMES,
  deployableCatalogBlock,
} from "./catalog-blocks";

const FAKE_PREFERENCES = [{ provider: "anthropic", model: "claude-sonnet-5" }];
const TENANT_DOMAIN = "acme.example";

describe("native catalog-block adapter", () => {
  test("the deployable set is the native catalog minus assistant and heartbeat", () => {
    const expected = WORKFLOW_CATALOG.map((entry) => entry.assetName)
      .filter((name) => name !== "assistant" && name !== "heartbeat")
      .sort();
    expect([...CATALOG_BLOCK_ASSET_NAMES].sort()).toEqual(expected);
  });

  test("every deployable block renders its real definition for the tenant", () => {
    for (const assetName of CATALOG_BLOCK_ASSET_NAMES) {
      const block = deployableCatalogBlock(assetName);
      expect(block).toBeDefined();
      expect(block?.assetName).toBe(assetName);
      expect(block?.displayName.length).toBeGreaterThan(0);
      const parsed = JSON.parse(
        block?.buildJson(TENANT_DOMAIN, FAKE_PREFERENCES) ?? "",
      ) as { stepOrder?: readonly string[] };
      expect(parsed.stepOrder?.length).toBeGreaterThan(0);
      expect(block?.buildJson(TENANT_DOMAIN, FAKE_PREFERENCES)).toContain(
        assetName,
      );
    }
  });

  test("code-review stamps the requesting tenant's trigger address", () => {
    const block = deployableCatalogBlock("code-review");
    expect(block?.buildJson(TENANT_DOMAIN, FAKE_PREFERENCES)).toContain(
      "code-review@acme.example",
    );
  });

  test("assistant, heartbeat, and unknown names answer undefined", () => {
    expect(deployableCatalogBlock("assistant")).toBeUndefined();
    expect(deployableCatalogBlock("heartbeat")).toBeUndefined();
    expect(deployableCatalogBlock("does-not-exist")).toBeUndefined();
  });
});
