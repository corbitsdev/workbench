// The UI floor's raw-id sweep: render every settings section's presentational
// view with a full, realistic fixture — a bench, a workbench, and a user each
// carrying a uuid-like id — and assert none of those ids ever reach visible
// text. Attribute values (an `<option value>`, a `key`) are not the floor's
// concern the way visible text is, so the sweep strips markup down to text
// content before searching it, the same way a person reading the screen
// would never see a `value=` attribute either.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountSectionView } from "../src/account-section";
import { GrantsTable } from "../src/grants-section";
import { PeopleTable } from "../src/people-section";
import { RolesTable } from "../src/roles-section";

const AGENT_REF_ID = "agt_8f14e45fceea167a5a36dedd4bea2543";
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

describe("raw-id sweep", () => {
  test("PeopleTable never renders a raw principal id or agent refId", () => {
    const markup = renderToStaticMarkup(
      <PeopleTable
        people={[
          {
            id: "3c1b1a2e-8b4f-4c8d-9a3e-9c2f1e6a7b1d",
            tenantId: "tnt_1",
            kind: "agent",
            refId: AGENT_REF_ID,
            displayName: AGENT_REF_ID,
            status: "active",
            roles: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
        roles={[]}
        onSuspend={() => undefined}
        onReactivate={() => undefined}
        onRemove={() => undefined}
        onRoleChange={() => undefined}
      />,
    );
    const text = visibleText(markup);
    expect(text).not.toContain(AGENT_REF_ID);
    expect(UUID_PATTERN.test(text)).toBe(false);
  });

  test("RolesTable never renders a role's raw id", () => {
    const markup = renderToStaticMarkup(
      <RolesTable
        roles={[
          {
            id: "3c1b1a2e-8b4f-4c8d-9a3e-9c2f1e6a7b1d",
            tenantId: "tnt_1",
            name: "Billing",
            isSystem: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
        onDelete={() => undefined}
        onRename={() => undefined}
      />,
    );
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });

  test("GrantsTable never renders a grant's raw id, only resolved names", () => {
    const markup = renderToStaticMarkup(
      <GrantsTable
        grants={[
          {
            id: "3c1b1a2e-8b4f-4c8d-9a3e-9c2f1e6a7b1d",
            tenantId: "tnt_1",
            roleId: "4c1b1a2e-8b4f-4c8d-9a3e-9c2f1e6a7b1e",
            roleName: "Billing",
            resource: "workflow",
            action: "read",
            effect: "allow",
            origin: "role",
            expiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
        onRevoke={() => undefined}
      />,
    );
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });

  test("AccountSectionView renders only the user's name and email, never a uuid", () => {
    const markup = renderToStaticMarkup(
      <AccountSectionView
        name="Ada Lovelace"
        email="ada@example.com"
        emailVerified={true}
      />,
    );
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });
});
