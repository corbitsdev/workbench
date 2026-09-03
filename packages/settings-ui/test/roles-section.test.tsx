// CL-6664: the "Assign a role" person picker must show only user-kind
// principals — the same roster as the People section. Agent/workflow
// machine identities are excluded to prevent placeholder-named garbage
// accounts from polluting the picker.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RoleAssignments } from "../src/roles-section";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function principal(
  kind: "user" | "agent" | "workflow",
  id: string,
  name: string,
) {
  return {
    id,
    tenantId: "tnt_1",
    kind,
    refId: `${kind}_${id}`,
    displayName: name,
    status: "active" as const,
    roles: [],
    ...timestamps,
  };
}

describe("RoleAssignments picker", () => {
  test("shows only user-kind principals, not agents or workflows", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[
          {
            id: "role_1",
            tenantId: "tnt_1",
            name: "Billing",
            isSystem: false,
            ...timestamps,
          },
        ]}
        principals={[
          principal("user", "prn_user", "Alice Anderson"),
          principal("agent", "prn_agent", "Research Assistant"),
          principal("workflow", "prn_wf", "Nightly digest"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );

    expect(markup).toContain("Alice Anderson");
    expect(markup).not.toContain("Research Assistant");
    expect(markup).not.toContain("Nightly digest");
    expect(markup).not.toContain("<optgroup");
  });

  test("shows no optgroups (flat list)", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[
          principal("user", "prn_1", "Alice Anderson"),
          principal("user", "prn_2", "Bob Baker"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    expect(markup).not.toContain("<optgroup");
    expect(markup).toContain("Alice Anderson");
    expect(markup).toContain("Bob Baker");
  });

  test("excludes agents from the assignments table too", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[
          principal("user", "prn_user", "Alice Anderson"),
          principal("agent", "prn_agent", "Research Assistant"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    // The assignments table header should exist but have no rows
    expect(markup).toContain("No one has been assigned a role yet.");
    expect(markup).not.toContain("Research Assistant");
  });

  test("does not show user kind label for single-kind list", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[principal("user", "prn_1", "Alice Anderson")]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    expect(markup).toContain("Alice Anderson");
    expect(markup).not.toContain("<optgroup");
  });
});
