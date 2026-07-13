/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("../../lib/hub-api", () => ({
  setOwnerCredential: () => Promise.reject(new Error("not used in this test")),
  clearOwnerCredential: () =>
    Promise.reject(new Error("not used in this test")),
}));

import { findOAuthProviderByAppCredential } from "@workbench/shared";
import type { OwnerCredentialState } from "@workbench/shared";
import { CredentialRow } from "./CredentialRow";

function renderRow(credential: OwnerCredentialState) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CredentialRow credential={credential} />
    </QueryClientProvider>,
  );
}

const LINEAR_APP: OwnerCredentialState = {
  providerName: "linear-oauth-app",
  label: "Linear OAuth app",
  kind: "tool",
  configured: false,
  updatedAt: null,
};

afterEach(cleanup);

describe("OAuth-app guided setup panel", () => {
  it("renders the computed hub callback URL and a copy control", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));

    // The callback is a HUB route: <hubBase>/oauth/callback/linear.
    expect(screen.getByText(/\/oauth\/callback\/linear$/));
    expect(screen.getByRole("button", { name: /copy redirect url/i }));
  });

  it("shows the plain-language scope descriptions and steps from the catalog", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));

    const config = findOAuthProviderByAppCredential("linear-oauth-app");
    expect(config).toBeDefined();
    if (!config) throw new Error("linear config missing");

    // Each scope renders as its plain-language description, NOT the raw string.
    for (const scope of config.scopes) {
      const gloss = config.scopeDescriptions[scope];
      expect(gloss).toBeDefined();
      if (!gloss) throw new Error(`missing gloss for ${scope}`);
      expect(screen.getByText(gloss));
    }
    // The raw scope string is not dumped as visible text.
    expect(screen.queryByText(config.scopes.join(", "))).toBeNull();
    // Every catalog step is rendered as a list item.
    for (const step of config.setup.steps) {
      expect(screen.getByText(step));
    }
  });

  it("warns that the client secret is shown only once, in the setup steps", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    expect(screen.getByText(/shown only once/i));
  });

  it("exposes an aria-live status region for the copy confirmation", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("links out to the provider OAuth docs in a new, opener-safe tab", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));

    const config = findOAuthProviderByAppCredential("linear-oauth-app");
    if (!config) throw new Error("linear config missing");

    const link = screen.getByRole("link", {
      name: /oauth setup docs/i,
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(config.setup.registerUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("labels the OAuth inputs as Client secret and Client ID", () => {
    renderRow(LINEAR_APP);
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    expect(screen.getByText("Client secret"));
    expect(screen.getByText("Client ID"));
  });

  it("does not render the guided panel for a plain API-key tool", () => {
    renderRow({
      providerName: "vercel",
      label: "Vercel",
      kind: "tool",
      configured: false,
      updatedAt: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    expect(screen.queryByText(/Redirect URL/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /copy redirect url/i }),
    ).toBeNull();
  });
});
