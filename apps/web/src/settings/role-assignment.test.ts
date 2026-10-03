import { describe, expect, test } from "bun:test";

import {
  assignFailureMessage,
  assignmentPrincipalLabel,
  compareAssignmentPrincipals,
} from "./role-assignment";
import { SETTINGS_STRINGS } from "./strings";
import { TenancyApiError, type Principal } from "./tenancy-api";

function principal(overrides: Partial<Principal> & Pick<Principal, "id" | "kind">): Principal {
  return {
    tenantId: "tenant-1",
    refId: overrides.id,
    displayName: "Alice Anderson",
    status: "active",
    roles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("assignFailureMessage", () => {
  test("a missing principal earns first-run guidance, not the transient error", () => {
    expect(assignFailureMessage(new TenancyApiError("The hub answered 404 for /roles.", 404))).toBe(
      SETTINGS_STRINGS.rolesAssignMissingPrincipalError,
    );
    expect(SETTINGS_STRINGS.rolesAssignMissingPrincipalError).not.toBe(
      SETTINGS_STRINGS.rolesAssignError,
    );
  });

  test("server and network failures stay on the transient error", () => {
    expect(assignFailureMessage(new TenancyApiError("The hub answered 500 for /roles.", 500))).toBe(
      SETTINGS_STRINGS.rolesAssignError,
    );
    expect(assignFailureMessage(new TenancyApiError("fetch failed"))).toBe(
      SETTINGS_STRINGS.rolesAssignError,
    );
    expect(assignFailureMessage(new Error("boom"))).toBe(SETTINGS_STRINGS.rolesAssignError);
  });
});

describe("assignmentPrincipalLabel", () => {
  test("a person keeps their bare name", () => {
    expect(assignmentPrincipalLabel(principal({ id: "prn-1", kind: "user" }))).toBe(
      "Alice Anderson",
    );
  });

  test("agent and workflow principals carry their kind", () => {
    expect(
      assignmentPrincipalLabel(
        principal({ id: "prn-2", kind: "agent", displayName: "Deploy Bot" }),
      ),
    ).toBe(`Deploy Bot — ${SETTINGS_STRINGS.peopleKindAgent}`);
    expect(
      assignmentPrincipalLabel(
        principal({ id: "prn-3", kind: "workflow", displayName: "Nightly" }),
      ),
    ).toBe(`Nightly — ${SETTINGS_STRINGS.peopleKindWorkflow}`);
  });
});

describe("compareAssignmentPrincipals", () => {
  test("people sort before agents before workflows", () => {
    const workflow = principal({ id: "prn-3", kind: "workflow", displayName: "Aaron" });
    const agent = principal({ id: "prn-2", kind: "agent", displayName: "Zed" });
    const person = principal({ id: "prn-1", kind: "user", displayName: "Zoe" });
    expect([workflow, agent, person].sort(compareAssignmentPrincipals).map((p) => p.id)).toEqual([
      "prn-1",
      "prn-2",
      "prn-3",
    ]);
  });
});
