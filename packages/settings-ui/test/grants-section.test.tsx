// CL-6077: three related grants fixes, exercised together against the
// same dialog —
//   1. the target picker is kind-blind no longer: "A person" became "A
//      person, agent, or workflow," and the specific-target select groups
//      by kind so a workflow's machine principal never reads as a person.
//   2. the preview sentence and the table both show plain-language
//      resource labels ("agent workflows"), not the raw slug
//      ("workflow-definition") — the slug survives only as a tooltip.
//   3. target-type and resource are guided KindCards, matching the same
//      who -> what -> effect card treatment CreateCredentialDialog uses.

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { CreateGrantDialog, GrantsTable } from "../src/grants-section";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function principal(kind: "user" | "agent" | "workflow", id: string, name: string) {
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

function mountDialog(
  principals: Parameters<typeof CreateGrantDialog>[0]["principals"] = [],
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CreateGrantDialog
        open
        onOpenChange={() => undefined}
        roles={[]}
        principals={principals}
        onCreate={() => undefined}
        submitting={false}
      />,
    );
  });
  return { container, root };
}

describe("CreateGrantDialog", () => {
  test("renames the principal target-type option to name every kind it covers", () => {
    const { container, root } = mountDialog();
    try {
      const cardTitles = [
        ...document.body.querySelectorAll(".settings-kind-card-title"),
      ].map((node) => node.textContent);
      expect(cardTitles).not.toContain("A person");
      expect(cardTitles).toContain("A person, agent, or workflow");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("target-type and resource render as guided cards, not bare selects", () => {
    const { container, root } = mountDialog();
    try {
      // KindCards renders a role="group" of pressable buttons, not <select>.
      expect(
        document.body.querySelector('[role=group][aria-label="Applies to"]'),
      ).not.toBeNull();
      expect(
        document.body.querySelector('[role=group][aria-label="Resource"]'),
      ).not.toBeNull();
      // The plain-language resource label is the card's visible title; the
      // raw slug, if shown at all, is secondary card detail — never the
      // preview sentence's wording.
      expect(document.body.textContent).toContain("agent workflows");
      const preview = document.body.querySelector(
        '[data-testid="grant-preview"]',
      );
      expect(preview?.textContent).not.toContain("workflow-definition");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("groups the specific-target select by principal kind once 'principal' is picked", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          <CreateGrantDialog
            open
            onOpenChange={() => undefined}
            roles={[]}
            principals={[
              principal("workflow", "prn_wf", "Nightly digest"),
              principal("user", "prn_user", "Alice Anderson"),
              principal("agent", "prn_agent", "Research Assistant"),
            ]}
            onCreate={() => undefined}
            submitting={false}
          />,
        );
      });

      const principalCard = [
        ...document.body.querySelectorAll("[role=group] button"),
      ].find((button) =>
        button.textContent?.includes("A person, agent, or workflow"),
      );
      expect(principalCard).not.toBeUndefined();
      act(() => (principalCard as HTMLButtonElement).click());

      const optgroups = [...document.body.querySelectorAll("optgroup")];
      expect(optgroups.map((group) => group.label)).toEqual([
        "user",
        "agent",
        "workflow",
      ]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("GrantsTable", () => {
  test("shows a plain-language resource label with the raw slug as a tooltip only", () => {
    const markup = renderToStaticMarkup(
      <GrantsTable
        grants={[
          {
            id: "grant_1",
            tenantId: "tnt_1",
            roleId: "role_1",
            roleName: "Billing",
            resource: "workflow-definition",
            action: "read",
            effect: "allow",
            origin: "role",
            expiresAt: null,
            ...timestamps,
          },
        ]}
        onRevoke={() => undefined}
      />,
    );
    const visibleText = markup.replace(/<[^>]*>/g, " ");
    expect(visibleText).toContain("agent workflows");
    expect(visibleText).not.toContain("workflow-definition");
    expect(markup).toContain('title="workflow-definition"');
  });
});
