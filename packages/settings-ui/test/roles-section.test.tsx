// CL-6077: the "Assign a role" person picker previously listed every
// principal — people, agents, and workflows — as flat, indistinguishable
// options. Grouping by kind (optgroup) means a workflow's machine
// principal can never be mistaken for a person's account in the picker.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PRINCIPAL_KIND_LABEL, PRINCIPAL_KIND_ORDER } from "../src/identity";
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
  test("groups the person select by principal kind, in user/agent/workflow order", () => {
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
          principal("workflow", "prn_wf", "Nightly digest"),
          principal("user", "prn_user", "Alice Anderson"),
          principal("agent", "prn_agent", "Research Assistant"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );

    const groupOrder = [...markup.matchAll(/<optgroup label="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(groupOrder).toEqual(
      PRINCIPAL_KIND_ORDER.map((kind) => PRINCIPAL_KIND_LABEL[kind]),
    );
    expect(groupOrder).not.toEqual([...PRINCIPAL_KIND_ORDER]);
  });

  test("omits an empty kind group entirely rather than an empty optgroup", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[principal("user", "prn_user", "Alice Anderson")]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    const groupOrder = [...markup.matchAll(/<optgroup label="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(groupOrder).toEqual([PRINCIPAL_KIND_LABEL.user]);
    expect(groupOrder).not.toEqual(["user"]);
  });
});
