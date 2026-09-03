// The hub connect hook must relaunch a live assistant the moment a
// `feedsTools` connector (Manus) is stored — not wait for a new invite,
// and not persist-only. `createHub` is not booted here; this is the
// hook body `apps/hub/src/index.ts` fires from `settleServiceConnection`.
import { describe, expect, test } from "bun:test";
import { CONNECTOR_REGISTRY } from "@workbench/templates/connectors";
import { reconcilePinnedToolPackagesAfterConnect } from "./connection-live-reconcile";

describe("reconcilePinnedToolPackagesAfterConnect", () => {
  test("manus connect relaunches live assistants that pin @corbits/manus-tools", async () => {
    const calls: { tenantId: string; packages: readonly string[] }[] = [];
    const result = await reconcilePinnedToolPackagesAfterConnect(
      {
        reconcilePinnedToolPackages: async (tenantId, packageNames) => {
          calls.push({ tenantId, packages: [...packageNames] });
          return { scanned: 1, relaunched: 1 };
        },
      },
      { tenantId: "ten_1", connectorId: "manus" },
    );

    expect(CONNECTOR_REGISTRY["manus"]?.feedsTools).toEqual([
      "@corbits/manus-tools",
    ]);
    expect(result).toEqual({ scanned: 1, relaunched: 1 });
    expect(calls).toEqual([
      { tenantId: "ten_1", packages: ["@corbits/manus-tools"] },
    ]);
  });

  test("an inference-only connector does not relaunch for tool-package pins", async () => {
    const calls: unknown[] = [];
    const result = await reconcilePinnedToolPackagesAfterConnect(
      {
        reconcilePinnedToolPackages: async (...args) => {
          calls.push(args);
          return { scanned: 0, relaunched: 0 };
        },
      },
      { tenantId: "ten_1", connectorId: "anthropic" },
    );

    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
