// Query-key helpers — pure unit coverage so the TanStack cutover does not
// depend only on page-level smoke. The APIQuery adapter itself
// (`toAPIQuery`) is covered in `@/lib/api-query`.

import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { meKeys, pathToQueryKey, tenantKeys } from "./query-client";

describe("pathToQueryKey", () => {
  test("maps identity-scoped hub paths onto meKeys", () => {
    expect(pathToQueryKey("/api/me")).toEqual(meKeys.profile);
    expect(pathToQueryKey("/api/me/principals")).toEqual(meKeys.principals);
  });

  test("maps the pending-approvals list onto a tenant-scoped key", () => {
    expect(pathToQueryKey("/api/tenants/tnt_1/approvals")).toEqual(
      tenantKeys.pendingApprovals("tnt_1"),
    );
  });

  test("maps tenant assets onto a tenant-scoped key", () => {
    expect(pathToQueryKey("/api/tenants/tnt_1/assets")).toEqual(tenantKeys.assets("tnt_1"));
  });

  test("falls back to a path key for unknown routes", () => {
    expect(pathToQueryKey("/api/mystery")).toEqual(["path", "/api/mystery"]);
  });
});

describe("tenantKeys.routineActivity", () => {
  // Keyed by the seam, not the deleted `/top-level-runs` route, so both
  // mounts share one cache entry.
  test("keys routine activity per tenant without the deleted route name", () => {
    expect(tenantKeys.routineActivity("tnt_1")).toEqual(["tenant", "tnt_1", "routine-activity"]);
    expect((tenantKeys.routineActivity("tnt_1") as readonly unknown[]).join("/")).not.toContain(
      "top-level-runs",
    );
  });
});

describe("tenantKeys.agents", () => {
  // Pins the `chatKeys.agents` migration: the approvals roster
  // (`pending-approvals.ts`) subscribes with this key while the agents page
  // (`agents-api.ts`) invalidates it, so both sides must spell it the same
  // way — one shared cached read, usually a hit.
  test("is the exact roster key both sides share, with no chat segment left", () => {
    expect(tenantKeys.agents("tnt_1")).toEqual(["tenant", "tnt_1", "agents", "roster"]);
    expect((tenantKeys.agents("tnt_1") as readonly unknown[]).join("/")).not.toContain("chat");
  });

  test("nests under tenantKeys.all so a bench switch drops it", () => {
    const all = tenantKeys.all("tnt_1");
    expect(tenantKeys.agents("tnt_1").slice(0, all.length)).toEqual([...all]);
  });

  test("a write under the key is visible to a subscriber and cleared by invalidation", async () => {
    const client = new QueryClient();
    client.setQueryData(tenantKeys.agents("tnt_1"), [{ name: "researcher-bot" }]);
    expect(
      client.getQueryData<readonly [{ readonly name: string }]>(tenantKeys.agents("tnt_1")),
    ).toEqual([{ name: "researcher-bot" }]);
    await client.invalidateQueries({ queryKey: tenantKeys.agents("tnt_1") });
    expect(client.getQueryState(tenantKeys.agents("tnt_1"))?.isInvalidated).toBe(true);
  });
});
