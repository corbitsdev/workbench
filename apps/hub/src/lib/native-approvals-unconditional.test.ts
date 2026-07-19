import { describe, expect, test } from "bun:test";
import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

import { resolveAskToolNamesForTenant } from "./native-approvals";
import type { HubDb } from "../db";

// CL-3940: native write-tool approvals gate unconditionally — there is no owner
// toggle and no env kill-switch. `resolveAskToolNamesForTenant` returns the
// approval-gated write set for every tenant and never touches the db (a
// throwing proxy proves no query is issued and no config flag is consulted).
const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be queried: gating is unconditional");
    },
  },
) as unknown as HubDb;

describe("resolveAskToolNamesForTenant (unconditional)", () => {
  test("returns the approval-gated write set with no db read", async () => {
    const names = await resolveAskToolNamesForTenant(throwingDb, "ten-any");
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
  });

  test("returns the same set for a different tenant (not per-tenant)", async () => {
    const names = await resolveAskToolNamesForTenant(throwingDb, "ten-other");
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
  });
});
