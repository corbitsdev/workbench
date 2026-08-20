// CredentialsTable's Type column: a raw enum ("oauth_token") reads as
// engineering internals, not settings copy — the visible cell shows a
// human label, and the raw slug survives only as a title/tooltip.

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { CredentialsTable } from "../src/credentials-section";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

describe("CredentialsTable", () => {
  test("shows a human label for the credential type, not the raw enum value", () => {
    const markup = renderToStaticMarkup(
      <CredentialsTable
        credentials={[
          {
            id: "cred_1",
            tenantId: "tnt_1",
            providerId: "prov_1",
            name: "OpenAI production",
            type: "oauth_token",
            status: "active",
            ...timestamps,
          },
        ]}
        providerNameById={new Map([["prov_1", "OpenAI"]])}
        onDelete={() => undefined}
      />,
    );
    expect(visibleText(markup)).toContain("OAuth token");
    expect(visibleText(markup)).not.toContain("oauth_token");
    expect(markup).toContain('title="oauth_token"');
  });

  test("a provider missing from providerNameById reads as Removed provider, never the raw providerId", () => {
    const markup = renderToStaticMarkup(
      <CredentialsTable
        credentials={[
          {
            id: "cred_1",
            tenantId: "tnt_1",
            providerId: "prov_gone",
            name: "Old key",
            type: "api_key",
            status: "revoked",
            ...timestamps,
          },
        ]}
        providerNameById={new Map()}
        onDelete={() => undefined}
      />,
    );
    expect(visibleText(markup)).toContain("Removed provider");
    expect(visibleText(markup)).not.toContain("prov_gone");
  });

  test("a row already deleting is disabled — a second click never fires a second delete", () => {
    const credential = {
      id: "cred_1",
      tenantId: "tnt_1",
      providerId: "prov_1",
      name: "OpenAI production",
      type: "api_key" as const,
      status: "active" as const,
      ...timestamps,
    };
    let deleteCalls = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <CredentialsTable
          credentials={[credential]}
          providerNameById={new Map([["prov_1", "OpenAI"]])}
          onDelete={() => {
            deleteCalls += 1;
          }}
          deletingIds={new Set(["cred_1"])}
        />,
      );
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Revoking");

    // Two clicks (arm + confirm) on a disabled button must never reach
    // onDelete — the busy row is not clickable at all.
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(deleteCalls).toBe(0);

    act(() => root.unmount());
    container.remove();
  });
});
