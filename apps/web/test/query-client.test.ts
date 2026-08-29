// Query-key helpers — pure unit coverage so the TanStack cutover does not
// depend only on page-level smoke. The APIQuery adapter itself
// (`toAPIQuery`) is covered in `@corbits/api-query`.

import { describe, expect, test } from "bun:test";

import { meKeys, pathToQueryKey, tenantKeys } from "../src/query-client";

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
    expect(pathToQueryKey("/api/tenants/tnt_1/assets")).toEqual(
      tenantKeys.assets("tnt_1"),
    );
  });

  test("falls back to a path key for unknown routes", () => {
    expect(pathToQueryKey("/api/mystery")).toEqual(["path", "/api/mystery"]);
  });
});
