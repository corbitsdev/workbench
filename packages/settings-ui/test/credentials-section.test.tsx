// CredentialsTable's Type column: a raw enum ("oauth_token") reads as
// engineering internals, not settings copy — the visible cell shows a
// human label, and the raw slug survives only as a title/tooltip.

import { describe, expect, test } from "bun:test";
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
});
