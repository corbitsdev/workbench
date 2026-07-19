import { afterEach, describe, expect, mock, test } from "bun:test";
import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

// The staff env override (`NATIVE_APPROVALS_ENABLED`) is on. `envOverride: true`
// short-circuits the feature check before any grant-store read, so the ask set
// resolves purely from the env flag — the global staff enable path, reachable
// without any owner grant. A stub db proves no query is issued.
mock.module("../config", () => ({
  getConfig: () => ({
    featureGrantCacheTtlMs: 30_000,
    nativeApprovalsEnabled: true,
  }),
}));

import { resolveAskToolNamesForTenant } from "./native-approvals";
import { resetFeatureGrantCache } from "./feature-grants";
import type { HubDb } from "../db";

const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be queried when the env override is on");
    },
  },
) as unknown as HubDb;

afterEach(() => resetFeatureGrantCache());

describe("resolveAskToolNamesForTenant env override", () => {
  test("returns the approval-gated set from the env flag alone, no db read", async () => {
    const names = await resolveAskToolNamesForTenant(throwingDb, "ten-any");
    expect(names).toEqual(APPROVAL_GATED_TOOL_NAMES);
  });
});
