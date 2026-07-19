import { describe, expect, test } from "bun:test";
import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

import { resolveAskToolNamesForTenant } from "./native-approvals";

// CL-3940: native write-tool approvals gate unconditionally — there is no owner
// toggle and no env kill-switch. `resolveAskToolNamesForTenant` returns the
// approval-gated write set with no inputs (the former `db`/`tenantId` seam is
// removed now that the result is a constant).
describe("resolveAskToolNamesForTenant (unconditional)", () => {
  test("returns the approval-gated write set", async () => {
    const names = await resolveAskToolNamesForTenant();
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
  });
});
